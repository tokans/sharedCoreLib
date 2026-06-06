import { describe, it, expect } from "vitest";
import { encryptJson, decryptJson, PBKDF2_ITERATIONS } from "./index.js";

const ENC = new TextEncoder();

/** Re-creates the pre-versioning legacy package: salt(16)‖iv(12)‖ct, PBKDF2@150k, no AAD. */
async function legacyEncrypt(value: unknown, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", ENC.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150_000, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENC.encode(JSON.stringify(value))));
  const out = new Uint8Array(16 + 12 + ct.length);
  out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
  return out;
}

describe("export crypto", () => {
  it("round-trips a value (v1)", async () => {
    const sealed = await encryptJson({ hello: "world", n: 42 }, "correct horse");
    expect(await decryptJson(sealed, "correct horse")).toEqual({ hello: "world", n: 42 });
  });

  it("uses the 600k work factor floor", () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it("fails on a wrong passphrase", async () => {
    const sealed = await encryptJson({ a: 1 }, "right");
    await expect(decryptJson(sealed, "wrong")).rejects.toBeTruthy();
  });

  it("binds AAD: matching opens, mismatched fails", async () => {
    const sealed = await encryptJson({ a: 1 }, "pw", { aad: "myapp:export" });
    expect(await decryptJson(sealed, "pw", { aad: "myapp:export" })).toEqual({ a: 1 });
    await expect(decryptJson(sealed, "pw", { aad: "other" })).rejects.toBeTruthy();
    await expect(decryptJson(sealed, "pw")).rejects.toBeTruthy();
  });

  it("still opens legacy (unversioned, 150k) packages", async () => {
    const legacy = await legacyEncrypt({ legacy: true }, "shared-pass");
    expect(await decryptJson(legacy, "shared-pass")).toEqual({ legacy: true });
  });

  it("rejects a too-short blob", async () => {
    await expect(decryptJson(new Uint8Array(5), "pw")).rejects.toBeTruthy();
  });
});
