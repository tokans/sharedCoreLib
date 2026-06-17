import { describe, it, expect, vi } from "vitest";
import { provisionLang, isLangProvisioned, sha256Hex } from "../src/ocr/assets";
import { OcrIntegrityError, type OcrAssetHost } from "../src/ocr/types";

const LANG = "eng.traineddata.gz";
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

/** A fully in-memory OcrAssetHost so the provision flow is testable without I/O. */
function memoryHost(overrides: Partial<OcrAssetHost> = {}): OcrAssetHost & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    download: vi.fn(async () => BYTES),
    hasCached: vi.fn(async (name: string) => store.has(name)),
    readCached: vi.fn(async (name: string) => {
      const b = store.get(name);
      if (!b) throw new Error("not cached");
      return b;
    }),
    writeCached: vi.fn(async (name: string, bytes: Uint8Array) => {
      store.set(name, bytes);
    }),
    cacheDirUrl: vi.fn(async () => `asset://local/ocr`),
    ...overrides,
  };
}

describe("sha256Hex", () => {
  it("hashes a subarray by its own bytes, not the backing buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2); // == BYTES
    expect(await sha256Hex(view)).toBe(await sha256Hex(BYTES));
  });
});

describe("provisionLang", () => {
  it("downloads, verifies, caches, and returns the local URL", async () => {
    const host = memoryHost();
    const want = await sha256Hex(BYTES);
    const url = await provisionLang({ host, baseUrl: "https://h/x", langFile: LANG, langSha256: want });
    expect(url).toBe(`asset://local/ocr`);
    expect(host.download).toHaveBeenCalledWith("https://h/x/" + LANG, expect.anything());
    expect(host.writeCached).toHaveBeenCalledWith(LANG, BYTES);
  });

  it("throws OcrIntegrityError and does NOT write on a hash mismatch", async () => {
    const host = memoryHost();
    await expect(
      provisionLang({ host, baseUrl: "https://h", langFile: LANG, langSha256: "deadbeef" }),
    ).rejects.toBeInstanceOf(OcrIntegrityError);
    expect(host.writeCached).not.toHaveBeenCalled();
    expect(host.store.has(LANG)).toBe(false);
  });

  it("reuses a valid cached copy without downloading", async () => {
    const want = await sha256Hex(BYTES);
    const host = memoryHost();
    host.store.set(LANG, BYTES);
    const url = await provisionLang({ host, baseUrl: "https://h", langFile: LANG, langSha256: want });
    expect(url).toBe(`asset://local/ocr`);
    expect(host.download).not.toHaveBeenCalled();
  });

  it("re-downloads when the cached copy is stale", async () => {
    const want = await sha256Hex(BYTES);
    const host = memoryHost();
    host.store.set(LANG, new Uint8Array([0, 0, 0])); // wrong bytes cached
    const url = await provisionLang({ host, baseUrl: "https://h", langFile: LANG, langSha256: want });
    expect(url).toBe(`asset://local/ocr`);
    expect(host.download).toHaveBeenCalledTimes(1);
    expect(host.store.get(LANG)).toEqual(BYTES);
  });

  it("propagates an aborted download", async () => {
    const host = memoryHost({
      download: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(
      provisionLang({ host, baseUrl: "https://h", langFile: LANG, langSha256: "x" }),
    ).rejects.toThrow();
  });
});

describe("isLangProvisioned", () => {
  it("is false when absent, true when cached + valid", async () => {
    const want = await sha256Hex(BYTES);
    const host = memoryHost();
    expect(await isLangProvisioned({ host, baseUrl: "h", langFile: LANG, langSha256: want })).toBe(false);
    host.store.set(LANG, BYTES);
    expect(await isLangProvisioned({ host, baseUrl: "h", langFile: LANG, langSha256: want })).toBe(true);
  });

  it("is false when the cached copy fails verification", async () => {
    const host = memoryHost();
    host.store.set(LANG, new Uint8Array([7, 7, 7]));
    expect(await isLangProvisioned({ host, baseUrl: "h", langFile: LANG, langSha256: "deadbeef" })).toBe(false);
  });
});
