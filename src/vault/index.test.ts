import { describe, it, expect } from "vitest";
import { sealWithKey, openWithKey } from "./index.js";

const key = () => crypto.getRandomValues(new Uint8Array(32));

/** Legacy sealed blob: iv(12)‖ct, no magic, no AAD. */
async function legacySeal(raw: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}

describe("vault sealWithKey/openWithKey", () => {
  const plain = new TextEncoder().encode("document bytes");

  it("round-trips (v1)", async () => {
    const k = key();
    const sealed = await sealWithKey(k, plain);
    expect(new TextDecoder().decode(await openWithKey(k, sealed))).toBe("document bytes");
  });

  it("binds AAD: matching filename opens, a different one fails", async () => {
    const k = key();
    const sealed = await sealWithKey(k, plain, "file-A");
    expect(await openWithKey(k, sealed, "file-A")).toEqual(plain);
    await expect(openWithKey(k, sealed, "file-B")).rejects.toBeTruthy();
  });

  it("fails with the wrong key", async () => {
    const sealed = await sealWithKey(key(), plain);
    await expect(openWithKey(key(), sealed)).rejects.toBeTruthy();
  });

  it("still opens legacy (unversioned, no-AAD) blobs", async () => {
    const k = key();
    const legacy = await legacySeal(k, plain);
    expect(await openWithKey(k, legacy)).toEqual(plain);
  });
});
