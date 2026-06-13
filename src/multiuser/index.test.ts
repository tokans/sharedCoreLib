import { describe, it, expect } from "vitest";
import {
  generateSharedKey, multiWrap, unwrapShared, addMember, removeMember, coUserRewrap,
  privateCompartment, compartmentOf, canAccessCompartment, syncTargets, rowsForRecipient,
  createPrivateCompartmentKey, unwrapPrivateCompartmentKey, keyForCompartment,
  sealForCompartment, openForCompartment,
  type Member, type CompartmentKeyring,
} from "./index.js";

const alice: Member = { userId: "alice", userKey: "ALICE-KEY-AAAA-BBBB" };
const bob: Member = { userId: "bob", userKey: "BOB-KEY-CCCC-DDDD" };
const carol: Member = { userId: "carol", userKey: "CAROL-KEY-EEEE-FFFF" };

describe("shared key multi-wrap", () => {
  it("every member unwraps the same shared key; a wrong key fails", async () => {
    const sk = generateSharedKey();
    const wraps = await multiWrap(sk, [alice, bob]);
    expect([...(await unwrapShared(wraps, "alice", alice.userKey))]).toEqual([...sk]);
    expect([...(await unwrapShared(wraps, "bob", bob.userKey))]).toEqual([...sk]);
    await expect(unwrapShared(wraps, "alice", bob.userKey)).rejects.toThrow();
  });

  it("addMember grants the existing key without rotating", async () => {
    const sk = generateSharedKey();
    let wraps = await multiWrap(sk, [alice]);
    wraps = await addMember(wraps, sk, bob);
    expect([...(await unwrapShared(wraps, "bob", bob.userKey))]).toEqual([...sk]);
    expect([...(await unwrapShared(wraps, "alice", alice.userKey))]).toEqual([...sk]); // unchanged
  });

  it("removeMember rotates the key — the removed member can't reach the new key", async () => {
    const sk = generateSharedKey();
    const wraps = await multiWrap(sk, [alice, bob, carol]);
    const { sharedKey: newSk, wraps: newWraps } = await removeMember([alice, bob]);
    // remaining members get the new key
    expect([...(await unwrapShared(newWraps, "alice", alice.userKey))]).toEqual([...newSk]);
    // carol has no wrap in the new set, and her old wrap yields the OLD key, not the new one
    expect(newWraps.carol).toBeUndefined();
    expect([...(await unwrapShared(wraps, "carol", carol.userKey))]).not.toEqual([...newSk]);
  });

  it("co-user recovery re-wraps the shared key for a locked-out user under a fresh key", async () => {
    const sk = generateSharedKey();
    const { userKey, wrap } = await coUserRewrap(sk, "bob");
    expect([...(await unwrapShared({ bob: wrap }, "bob", userKey))]).toEqual([...sk]);
  });
});

describe("private compartments", () => {
  it("shared rows are readable by all; private rows only by the owner", () => {
    expect(canAccessCompartment("shared", "alice")).toBe(true);
    expect(canAccessCompartment(privateCompartment("alice"), "alice")).toBe(true);
    expect(canAccessCompartment(privateCompartment("alice"), "bob")).toBe(false);
  });

  it("compartmentOf defaults untagged rows to shared", () => {
    expect(compartmentOf({})).toBe("shared");
    expect(compartmentOf({ compartment: "private:alice" })).toBe("private:alice");
    expect(compartmentOf({ compartment: "garbage" })).toBe("shared");
  });

  it("syncTargets: shared → all devices, private → owner only", () => {
    const all = ["alice", "bob", "carol"];
    expect(syncTargets("shared", all)).toEqual(all);
    expect(syncTargets(privateCompartment("bob"), all)).toEqual(["bob"]);
    expect(syncTargets(privateCompartment("dave"), all)).toEqual([]); // not a member
  });

  it("rowsForRecipient sends shared + own-private, never another user's private", () => {
    const rows = [
      { id: 1, compartment: "shared" },
      { id: 2, compartment: "private:alice" },
      { id: 3, compartment: "private:bob" },
    ];
    expect(rowsForRecipient(rows, "alice").map((r) => r.id)).toEqual([1, 2]);
    expect(rowsForRecipient(rows, "bob").map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("crypto-hard private compartments (per-user keys)", () => {
  it("a member can unwrap their OWN private key; nobody else can", async () => {
    const { wrapped } = await createPrivateCompartmentKey(alice);
    await expect(unwrapPrivateCompartmentKey(wrapped, alice.userKey)).resolves.toBeInstanceOf(Uint8Array);
    // Bob (or anyone) with the wrong user key fails the GCM tag — he cannot derive Alice's PK.
    await expect(unwrapPrivateCompartmentKey(wrapped, bob.userKey)).rejects.toThrow();
  });

  it("keyForCompartment yields a key for self/shared, but NULL for another's private", async () => {
    const sk = generateSharedKey();
    const { key: alicePk } = await createPrivateCompartmentKey(alice);
    const aliceRing: CompartmentKeyring = { userId: "alice", sharedKey: sk, privateKey: alicePk };
    expect(keyForCompartment("shared", aliceRing)).toBe(sk);
    expect(keyForCompartment(privateCompartment("alice"), aliceRing)).toBe(alicePk);
    expect(keyForCompartment(privateCompartment("bob"), aliceRing)).toBeNull(); // crypto-hard: no key held
  });

  it("a foreign private row is UNREADABLE even with its ciphertext in hand", async () => {
    const sk = generateSharedKey();
    const { key: alicePk } = await createPrivateCompartmentKey(alice);
    const { key: bobPk } = await createPrivateCompartmentKey(bob);
    const aliceRing: CompartmentKeyring = { userId: "alice", sharedKey: sk, privateKey: alicePk };
    const bobRing: CompartmentKeyring = { userId: "bob", sharedKey: sk, privateKey: bobPk };

    // Alice seals a private note. The ciphertext is handed to Bob (e.g. a leaked/synced blob).
    const blob = await sealForCompartment({ note: "alice-only secret" }, privateCompartment("alice"), aliceRing);
    // Bob holds no key for Alice's compartment → openForCompartment returns null (not the data).
    expect(await openForCompartment(blob, privateCompartment("alice"), bobRing)).toBeNull();
    // Alice opens her own.
    expect(await openForCompartment<{ note: string }>(blob, privateCompartment("alice"), aliceRing))
      .toEqual({ note: "alice-only secret" });
  });

  it("shared rows are readable by every member; sealing into another's space throws", async () => {
    const sk = generateSharedKey();
    const aliceRing: CompartmentKeyring = { userId: "alice", sharedKey: sk };
    const bobRing: CompartmentKeyring = { userId: "bob", sharedKey: sk };
    const blob = await sealForCompartment({ v: 42 }, "shared", aliceRing);
    expect(await openForCompartment<{ v: number }>(blob, "shared", bobRing)).toEqual({ v: 42 });
    // Alice cannot seal INTO Bob's private compartment (she holds no key for it).
    await expect(sealForCompartment({ v: 1 }, privateCompartment("bob"), aliceRing)).rejects.toThrow(/no key/);
  });

  it("the AAD binds a sealed payload to its compartment (no cross-compartment replay)", async () => {
    const sk = generateSharedKey();
    const { key: alicePk } = await createPrivateCompartmentKey(alice);
    const aliceRing: CompartmentKeyring = { userId: "alice", sharedKey: sk, privateKey: alicePk };
    const blob = await sealForCompartment({ note: "x" }, privateCompartment("alice"), aliceRing);
    // Re-tagging the same bytes as a shared row must fail the AAD check, not silently open.
    await expect(openForCompartment(blob, "shared", aliceRing)).rejects.toThrow();
  });
});
