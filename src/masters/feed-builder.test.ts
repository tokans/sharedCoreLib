import { describe, it, expect, beforeAll } from "vitest";
import { signAsync, getPublicKeyAsync, etc } from "@noble/ed25519";
import {
  verifyAndDecryptManifest,
  createCachedFetch,
  sha256Hex,
  type ExpectedFile,
  type CacheFs,
} from "./index.js";
import { buildMastersManifest, type MasterFeedEntryInput } from "./feed-builder.js";

const ENC = new TextEncoder();

// A throwaway transport key (32 bytes) + signing key, mirroring the suite test setup.
const transportKeyB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
let signPriv: Uint8Array;
let pubHex: string;

beforeAll(async () => {
  signPriv = crypto.getRandomValues(new Uint8Array(32));
  pubHex = etc.bytesToHex(await getPublicKeyAsync(signPriv));
});

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Build a bundle and sign its manifest exactly as the offline CLI would. */
async function buildAndSign(entries: MasterFeedEntryInput[], over: Partial<{ revision: number; minAppVersion: string }> = {}) {
  const built = await buildMastersManifest(entries, {
    revision: over.revision ?? 3,
    minAppVersion: over.minAppVersion ?? "1.0.0",
    transportKeyB64,
    generatedAt: "2026-06-16T00:00:00Z",
  });
  const sigBytes = await signAsync(built.manifestBytes, signPriv);
  return { built, sigB64: b64(sigBytes), sigBytes };
}

describe("buildMastersManifest → verifyAndDecryptManifest round-trip", () => {
  const entries: MasterFeedEntryInput[] = [
    { id: "common:country", version: 2, payload: [{ value: "IN", label: "India" }] },
    { id: "myfinance:institution", version: 5, payload: [{ value: "hdfc", label: "HDFC Bank" }] },
  ];

  it("the runtime verifier accepts the built bundle and recovers the payloads", async () => {
    const { built, sigBytes } = await buildAndSign(entries);
    const { manifest, entries: verified } = await verifyAndDecryptManifest(built.manifestBytes, sigBytes, {
      fetchFile: async (file) => built.files[file]!,
      pubkeyHex: pubHex,
      transportKeyB64,
    });
    expect(manifest.revision).toBe(3);
    expect(verified.map((e) => e.id).sort()).toEqual(["common:country", "myfinance:institution"]);
    const inst = verified.find((e) => e.id === "myfinance:institution")!;
    expect(inst.version).toBe(5);
    expect(inst.payload).toEqual([{ value: "hdfc", label: "HDFC Bank" }]);
  });

  it("manifest pins each file by size + sha256 of the ciphertext", async () => {
    const { built } = await buildAndSign(entries);
    for (const e of built.manifest.entries) {
      const bytes = built.files[e.file]!;
      expect(bytes.length).toBe(e.bytes);
      expect(await sha256Hex(bytes)).toBe(e.sha256);
    }
  });

  it("a tampered entry ciphertext fails the manifest hash gate", async () => {
    const { built, sigBytes } = await buildAndSign(entries);
    const target = built.manifest.entries[0]!.file;
    const tampered = { ...built.files, [target]: ENC.encode("not the real ciphertext") };
    await expect(
      verifyAndDecryptManifest(built.manifestBytes, sigBytes, {
        fetchFile: async (file) => tampered[file]!,
        pubkeyHex: pubHex,
        transportKeyB64,
      }),
    ).rejects.toThrow(/size mismatch|sha256 mismatch/);
  });

  it("a tampered manifest fails signature verification", async () => {
    const { built, sigBytes } = await buildAndSign(entries);
    const tamperedManifest = ENC.encode(new TextDecoder().decode(built.manifestBytes).replace('"revision": 3', '"revision": 9'));
    await expect(
      verifyAndDecryptManifest(tamperedManifest, sigBytes, {
        fetchFile: async (file) => built.files[file]!,
        pubkeyHex: pubHex,
        transportKeyB64,
      }),
    ).rejects.toThrow(/signature invalid/);
  });

  it("anti-downgrade: a revision at/below lastRevision is rejected", async () => {
    const { built, sigBytes } = await buildAndSign(entries, { revision: 3 });
    await expect(
      verifyAndDecryptManifest(built.manifestBytes, sigBytes, {
        fetchFile: async (file) => built.files[file]!,
        pubkeyHex: pubHex,
        transportKeyB64,
        lastRevision: 3,
      }),
    ).rejects.toThrow(/stale manifest revision/);
  });

  it("rejects duplicate ids and bad keys at build time", async () => {
    await expect(
      buildMastersManifest([entries[0]!, entries[0]!], {
        revision: 1, minAppVersion: "1.0.0", transportKeyB64, generatedAt: "2026-06-16T00:00:00Z",
      }),
    ).rejects.toThrow(/duplicate entry id/);
    await expect(
      buildMastersManifest(entries, {
        revision: 1, minAppVersion: "1.0.0", transportKeyB64: btoa("short"), generatedAt: "2026-06-16T00:00:00Z",
      }),
    ).rejects.toThrow(/transport key must be 32 bytes/);
  });
});

// ── Shared on-disk cache ─────────────────────────────────────────────────────

/** In-memory CacheFs that counts writes, for asserting reuse across apps. */
function fakeFs() {
  const store = new Map<string, Uint8Array>();
  let writes = 0;
  const fs: CacheFs = {
    exists: async (p) => store.has(p),
    readFile: async (p) => store.get(p)!,
    writeFile: async (p, d) => { store.set(p, d); writes += 1; },
    mkdir: async () => undefined,
  };
  return { fs, store, get writes() { return writes; } };
}

describe("createCachedFetch (shared bundle cache)", () => {
  const payload = ENC.encode("CIPHERTEXT-BYTES");
  let expected: ExpectedFile;
  beforeAll(async () => { expected = { bytes: payload.length, sha256: await sha256Hex(payload) }; });

  it("miss → fetches network and writes the cache", async () => {
    const c = fakeFs();
    let hits = 0;
    const fetch = createCachedFetch({
      fetchNetwork: async () => { hits += 1; return payload; },
      fs: c.fs, dir: "/shared/core/masters", namespace: "common",
    });
    const got = await fetch("common.bin", expected);
    expect(got).toEqual(payload);
    expect(hits).toBe(1);
    expect(c.writes).toBe(1);
    expect(c.store.has("/shared/core/masters/common/common.bin")).toBe(true);
  });

  it("valid hit → serves from cache, no network (the second app reuses the first's download)", async () => {
    const c = fakeFs();
    c.store.set("/shared/core/masters/common/common.bin", payload);
    let hits = 0;
    const fetch = createCachedFetch({
      fetchNetwork: async () => { hits += 1; return payload; },
      fs: c.fs, dir: "/shared/core/masters", namespace: "common",
    });
    const got = await fetch("common.bin", expected);
    expect(got).toEqual(payload);
    expect(hits).toBe(0);     // network never touched
    expect(c.writes).toBe(0); // nothing rewritten
  });

  it("stale/poisoned hit (sha mismatch) → ignores cache, re-fetches and rewrites", async () => {
    const c = fakeFs();
    c.store.set("/shared/core/masters/common/common.bin", ENC.encode("STALE"));
    let hits = 0;
    const fetch = createCachedFetch({
      fetchNetwork: async () => { hits += 1; return payload; },
      fs: c.fs, dir: "/shared/core/masters", namespace: "common",
    });
    const got = await fetch("common.bin", expected);
    expect(got).toEqual(payload);
    expect(hits).toBe(1);
    expect(c.store.get("/shared/core/masters/common/common.bin")).toEqual(payload); // overwritten
  });

  it("a failing cache never blocks the update (falls back to network)", async () => {
    const brokenFs: CacheFs = {
      exists: async () => { throw new Error("disk gone"); },
      readFile: async () => { throw new Error("disk gone"); },
      writeFile: async () => { throw new Error("read-only"); },
      mkdir: async () => { throw new Error("read-only"); },
    };
    const fetch = createCachedFetch({
      fetchNetwork: async () => payload,
      fs: brokenFs, dir: "/x", namespace: "common",
    });
    expect(await fetch("common.bin", expected)).toEqual(payload);
  });
});
