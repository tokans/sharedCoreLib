import { describe, it, expect } from "vitest";
import {
  createAccountClient, assertNoPlaintextSecrets, FORBIDDEN_EGRESS_KEYS,
  type HttpTransport, type Session,
} from "./index.js";

/** Fake transport that records every outgoing payload and returns canned responses. */
function fakeHttp(responses: Record<string, unknown> = {}) {
  const sent: { path: string; body: unknown }[] = [];
  const http: HttpTransport = {
    post: async (path, body) => { sent.push({ path, body }); return (responses[path] ?? {}) as never; },
    get: async (path) => (responses[path] ?? {}) as never,
  };
  return { http, sent };
}

const SESSION: Session = { accountId: "acc1", token: "tok1", tier: "registered" };

describe("egress guard", () => {
  it("rejects forbidden secret keys, recursively", () => {
    expect(() => assertNoPlaintextSecrets({ ok: 1, nested: { passphrase: "x" } })).toThrow(/passphrase/);
    for (const k of FORBIDDEN_EGRESS_KEYS) {
      expect(() => assertNoPlaintextSecrets({ [k]: "secret" })).toThrow();
    }
  });
  it("allows ciphertext + metadata", () => {
    expect(() => assertNoPlaintextSecrets({ accountId: "a", token: "t", blobB64: "AAAA", email: "x@y.z" })).not.toThrow();
  });
});

describe("account client — wire shapes carry only ciphertext + metadata", () => {
  it("register/login return a session", async () => {
    const { http } = fakeHttp({ "/account/register": { accountId: "acc1", token: "tok1", tier: "registered" } });
    const c = createAccountClient({ http });
    const s = await c.register("user@example.com");
    expect(s).toEqual(SESSION);
  });

  it("recovery escrow ships only the base64 blob — never the RK/plaintext", async () => {
    const { http, sent } = fakeHttp({ "/recovery/escrow/pull": { blobB64: "Y2lwaGVy" } });
    const c = createAccountClient({ http });
    const escrow = c.recoveryEscrow(SESSION);
    await escrow.push(new Uint8Array([1, 2, 3, 4]));
    const pushed = sent.find((x) => x.path === "/recovery/escrow/push")!.body as Record<string, unknown>;
    expect(pushed).toHaveProperty("blobB64");
    expect(Object.keys(pushed)).toEqual(["accountId", "token", "blobB64"]); // nothing else leaks
    const blob = await escrow.pull();
    expect(blob && [...blob]).toEqual([...Uint8Array.from(atob("Y2lwaGVy"), (c2) => c2.charCodeAt(0))]);
  });

  it("break-glass publish ships ciphertext; release is 2FA-gated (token in the release call)", async () => {
    const { http, sent } = fakeHttp({ "/breakglass/release": { blobB64: null } });
    const c = createAccountClient({ http });
    const bg = c.breakGlassEscrow(SESSION, (rid) => `2fa-${rid}`);
    await bg.publish("nominee-1", new Uint8Array([9, 9, 9]));
    await bg.release("nominee-1");
    const rel = sent.find((x) => x.path === "/breakglass/release")!.body as Record<string, unknown>;
    expect(rel.releaseToken).toBe("2fa-nominee-1"); // 2FA gates release of ciphertext
    expect(rel).not.toHaveProperty("blobB64"); // release REQUEST carries no data, only the gate
  });

  it("heartbeat carries email + last-used date and supports an 'I'm here' cancel", async () => {
    const { http, sent } = fakeHttp({
      "/account/heartbeat": { ok: true, nextDueDate: "2026-07-10", escalating: false },
      "/account/heartbeat/cancel": { ok: true },
    });
    const c = createAccountClient({ http });
    const hb = await c.heartbeat(SESSION, "user@example.com", "2026-06-10");
    expect(hb.nextDueDate).toBe("2026-07-10");
    const body = sent.find((x) => x.path === "/account/heartbeat")!.body as Record<string, unknown>;
    expect(body).toEqual({ accountId: "acc1", token: "tok1", email: "user@example.com", lastUsedDate: "2026-06-10" });
    expect((await c.heartbeatCancel(SESSION)).ok).toBe(true);
  });

  it("no outgoing payload across all calls contains a decrypting secret", async () => {
    const { http, sent } = fakeHttp();
    const c = createAccountClient({ http });
    await c.register("u@e.z");
    await c.recoveryEscrow(SESSION).push(new Uint8Array([1]));
    await c.breakGlassEscrow(SESSION, () => "2fa").publish("r", new Uint8Array([2]));
    await c.redeemPromiseCard(SESSION, new Uint8Array([3]), "mylifeassistant");
    for (const { body } of sent) expect(() => assertNoPlaintextSecrets(body)).not.toThrow();
  });

  it("verifyReceipt returns false offline when no server pubkey is configured", async () => {
    const { http } = fakeHttp();
    const c = createAccountClient({ http });
    expect(await c.verifyReceipt(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
  });
});
