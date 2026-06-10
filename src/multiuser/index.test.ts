import { describe, it, expect } from "vitest";
import {
  generateSharedKey, multiWrap, unwrapShared, addMember, removeMember, coUserRewrap,
  privateCompartment, compartmentOf, canAccessCompartment, syncTargets, rowsForRecipient,
  type Member,
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
