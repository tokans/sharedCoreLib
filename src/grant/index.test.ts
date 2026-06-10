import { describe, it, expect, beforeAll } from "vitest";
import { signAsync, getPublicKeyAsync, etc } from "@noble/ed25519";
import {
  verifyGrant, createGrantReceiver, type GrantKeys,
  parsePromiseCard, isCardExpired, cardBalance, checkRedeem, verifyPromiseCard,
  type PromiseCard, type CardDraw,
} from "./index.js";

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

describe("promise-card credit model", () => {
  const card: PromiseCard = {
    v: 1, kind: "promise-card", cardId: "card-1", identity: "acct-hash-xyz",
    currency: "INR", amountMinor: 50000, issuedAt: "2026-06-01", expiresAt: "2027-06-01",
    products: ["myworkassistant", "mylifeassistant"],
  };

  it("parsePromiseCard rejects anonymous / malformed cards", () => {
    expect(() => parsePromiseCard({ ...card, identity: "" })).toThrow(/identity-bound/);
    expect(() => parsePromiseCard({ ...card, amountMinor: 0 })).toThrow(/positive/);
    expect(() => parsePromiseCard({ kind: "patron" })).toThrow(/not a promise card/);
    expect(parsePromiseCard(card)).toEqual(card);
  });

  it("expiry + balance + draw-down", () => {
    expect(isCardExpired(card, "2026-12-01")).toBe(false);
    expect(isCardExpired(card, "2027-06-01")).toBe(true);
    const draws: CardDraw[] = [{ cardId: "card-1", amountMinor: 20000, product: "myworkassistant", at: "2026-07-01" }];
    expect(cardBalance(card, draws)).toBe(30000);
  });

  it("checkRedeem enforces identity, expiry, product, and balance", () => {
    const base = { product: "mylifeassistant" as const, amountMinor: 10000, nowIso: "2026-12-01", identity: "acct-hash-xyz" };
    expect(checkRedeem(card, [], base).ok).toBe(true);
    expect(checkRedeem(card, [], { ...base, identity: "someone-else" }).reason).toBe("identity mismatch");
    expect(checkRedeem(card, [], { ...base, nowIso: "2027-07-01" }).reason).toBe("expired");
    expect(checkRedeem({ ...card, products: ["myworkassistant"] }, [], base).reason).toBe("product not eligible");
    expect(checkRedeem(card, [], { ...base, amountMinor: 99999 }).reason).toBe("insufficient balance");
  });

  it("verifyPromiseCard verifies a signed card offline and reports redeemability", async () => {
    const bytes = await makeGrant(card);
    const { card: verified, check } = await verifyPromiseCard(bytes, keys, {
      product: "mylifeassistant", amountMinor: 10000, nowIso: "2026-12-01", identity: "acct-hash-xyz",
    });
    expect(verified.cardId).toBe("card-1");
    expect(check.ok).toBe(true);
    // a forged/tampered card fails signature verification
    await expect(verifyPromiseCard(await makeGrant(card), { ...keys, pubkeyHex: "00".repeat(32) }, {
      product: "mylifeassistant", amountMinor: 1, nowIso: "2026-12-01", identity: "acct-hash-xyz",
    })).rejects.toBeTruthy();
  });
});
