import { describe, it, expect, beforeAll } from "vitest";
import { signAsync, getPublicKeyAsync, etc } from "@noble/ed25519";
import { verifyGrant, createGrantReceiver, type GrantKeys } from "./index.js";

const ENC = new TextEncoder();
let priv: Uint8Array;
let keys: GrantKeys;
const transportKeyB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a real signed+encrypted grant envelope (iv‖ct‖tag, Ed25519 over enc). */
async function makeGrant(payload: unknown): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", b64ToBytes(transportKeyB64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENC.encode(JSON.stringify(payload))));
  const enc = new Uint8Array(12 + ctTag.length);
  enc.set(iv, 0); enc.set(ctTag, 12);
  const sig = await signAsync(enc, priv);
  return ENC.encode(JSON.stringify({ v: 1, enc: b64(enc), sig: b64(sig) }));
}

beforeAll(async () => {
  priv = crypto.getRandomValues(new Uint8Array(32));
  keys = { pubkeyHex: etc.bytesToHex(await getPublicKeyAsync(priv)), transportKeyB64 };
});

describe("receive-only grant handoff", () => {
  const payload = { kind: "patron", since: "2026-06-06" };

  it("verifyGrant round-trips a signed+encrypted envelope", async () => {
    expect(await verifyGrant(await makeGrant(payload), keys)).toEqual(payload);
  });

  it("rejects a tampered ciphertext / wrong key", async () => {
    const env = JSON.parse(new TextDecoder().decode(await makeGrant(payload)));
    env.enc = b64(b64ToBytes(env.enc).map((b, i) => (i === 20 ? b ^ 1 : b)) as unknown as Uint8Array);
    await expect(verifyGrant(ENC.encode(JSON.stringify(env)), keys)).rejects.toBeTruthy();
    await expect(verifyGrant(await makeGrant(payload), { ...keys, pubkeyHex: "00".repeat(32) })).rejects.toBeTruthy();
  });

  it("receiver: fromFile and fromToken verify; bad token → null", async () => {
    const bytes = await makeGrant(payload);
    const receiver = createGrantReceiver<{ kind: string; since: string }>({
      ...keys,
      parsePayload: (raw) => raw as { kind: string; since: string },
      readDroppedFile: async () => bytes,
      fetchByToken: async (t) => (t === "DONATION-REF-123" ? bytes : null),
    });
    expect(await receiver.fromFile()).toEqual(payload);
    expect(await receiver.fromToken("DONATION-REF-123")).toEqual(payload);
    expect(await receiver.fromToken("nope")).toBeNull();
    expect(await receiver.fromToken("")).toBeNull();
  });

  it("receiver returns null (not throw) when a channel is absent or invalid", async () => {
    const receiver = createGrantReceiver({ ...keys, parsePayload: (r) => r });
    expect(await receiver.fromFile()).toBeNull();   // no readDroppedFile adapter
    expect(await receiver.fromToken("x")).toBeNull(); // no fetchByToken adapter
  });
});
