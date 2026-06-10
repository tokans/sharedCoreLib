import { describe, it, expect } from "vitest";
import {
  generateRecoveryKey, normalizeRecoveryKey, wrapMasterKey, unwrapMasterKey,
  createRecovery, splitSecret, combineShares, splitRecoveryKey, combineRecoveryKey,
  type RecoveryBlobStore, type EscrowClient, type WrappedKey,
} from "./index.js";

const mk = () => crypto.getRandomValues(new Uint8Array(32));

function memBlobStore(): RecoveryBlobStore {
  let blob: WrappedKey | null = null;
  return {
    save: async (b) => { blob = b; },
    load: async () => blob,
    clear: async () => { blob = null; },
  };
}

function memEscrow(): EscrowClient & { seen: WrappedKey[] } {
  const seen: WrappedKey[] = [];
  return {
    seen,
    push: async (b) => { seen.push(b); },
    pull: async () => seen.at(-1) ?? null,
  };
}

describe("recovery key", () => {
  it("generates high-entropy, grouped, normalizable keys", () => {
    const rk = generateRecoveryKey();
    expect(rk).toMatch(/^[0-9A-Z-]+$/);
    expect(rk).toContain("-");
    expect(normalizeRecoveryKey(rk)).not.toContain("-");
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey()); // random
  });
});

describe("wrap / unwrap", () => {
  it("round-trips the master key under the RK", async () => {
    const key = mk(), rk = generateRecoveryKey();
    const blob = await wrapMasterKey(key, rk);
    const back = await unwrapMasterKey(blob, rk);
    expect([...back]).toEqual([...key]);
  });
  it("a wrong RK fails (blob is undecryptable without the RK)", async () => {
    const blob = await wrapMasterKey(mk(), generateRecoveryKey());
    await expect(unwrapMasterKey(blob, generateRecoveryKey())).rejects.toThrow();
  });
  it("tolerates user formatting (spaces/dashes/case)", async () => {
    const key = mk(), rk = generateRecoveryKey();
    const blob = await wrapMasterKey(key, rk);
    const messy = ` ${rk.toLowerCase().replace(/-/g, " ")} `;
    expect([...(await unwrapMasterKey(blob, messy))]).toEqual([...key]);
  });
});

describe("createRecovery", () => {
  it("enroll → recover round-trip via local blob (free, offline, no escrow)", async () => {
    const r = createRecovery({ blobStore: memBlobStore() });
    const key = mk();
    const { recoveryKey } = await r.enroll(key);
    expect([...(await r.recover(recoveryKey))]).toEqual([...key]);
  });

  it("escrow stores only ciphertext (vendor cannot decrypt) and restores on a fresh device", async () => {
    const store = memBlobStore(), escrow = memEscrow();
    const r = createRecovery({ blobStore: store, escrow });
    const key = mk();
    const { recoveryKey } = await r.enroll(key);
    expect(escrow.seen).toHaveLength(1);
    // the escrowed payload is ciphertext: it must not be JSON-parseable plaintext
    expect(() => JSON.parse(new TextDecoder().decode(escrow.seen[0]!))).toThrow();

    // fresh device: empty local store, pull from escrow, unwrap with the RK
    const fresh = createRecovery({ blobStore: memBlobStore(), escrow });
    expect([...(await fresh.recover(recoveryKey))]).toEqual([...key]);
  });

  it("rekey mints a new RK and invalidates the old one (forward protection)", async () => {
    const r = createRecovery({ blobStore: memBlobStore() });
    const key = mk();
    const { recoveryKey: oldRk } = await r.enroll(key);
    const { recoveryKey: newRk } = await r.rekey(key);
    expect(newRk).not.toBe(oldRk);
    expect([...(await r.recover(newRk))]).toEqual([...key]);
    await expect(r.recover(oldRk)).rejects.toThrow(); // old RK no longer opens the current blob
  });
});

describe("Shamir M-of-N", () => {
  it("any threshold shares reconstruct; fewer do not", () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const shares = splitSecret(secret, 5, 3);
    expect(shares).toHaveLength(5);
    // any 3 of 5 reconstruct
    expect([...combineShares([shares[0]!, shares[2]!, shares[4]!])]).toEqual([...secret]);
    expect([...combineShares([shares[1]!, shares[3]!, shares[4]!])]).toEqual([...secret]);
    // 2 shares do NOT reconstruct the secret (overwhelmingly)
    expect([...combineShares([shares[0]!, shares[1]!])]).not.toEqual([...secret]);
  });

  it("splits and reconstructs a Recovery Key string", () => {
    const rk = generateRecoveryKey();
    const shares = splitRecoveryKey(rk, 3, 2);
    expect(combineRecoveryKey([shares[0]!, shares[2]!])).toBe(normalizeRecoveryKey(rk));
  });

  it("rejects invalid (threshold, n)", () => {
    expect(() => splitSecret(new Uint8Array(4), 3, 1)).toThrow();
    expect(() => splitSecret(new Uint8Array(4), 2, 3)).toThrow();
  });
});
