import { describe, it, expect } from "vitest";
import {
  scanText, scanPayload, redactText, deidentifyText, redactPayload,
  regexEngine, openMedEngine, PiiEgressDialog, summarizeMatches,
} from "./index.js";

describe("scanText", () => {
  it("detects email, PAN, Aadhaar, Luhn-valid card, IP", () => {
    const kinds = (t: string) => scanText(t).map((m) => m.kind).sort();
    expect(scanText("reach me at a@b.co")[0]).toMatchObject({ kind: "email", value: "a@b.co" });
    expect(kinds("PAN ABCDE1234F")).toContain("pan");
    expect(kinds("uid 1234 5678 9012")).toContain("aadhaar");
    expect(kinds("card 4111 1111 1111 1111")).toContain("creditcard"); // valid Luhn
    expect(kinds("host 192.168.1.1")).toContain("ip");
  });
  it("rejects a Luhn-invalid card and an out-of-range IP", () => {
    expect(scanText("4111 1111 1111 1112").some((m) => m.kind === "creditcard")).toBe(false);
    expect(scanText("999.999.999.999").some((m) => m.kind === "ip")).toBe(false);
  });
  it("doesn't double-count an Aadhaar as a phone", () => {
    const kinds = scanText("1234 5678 9012").map((m) => m.kind);
    expect(kinds).toContain("aadhaar");
    expect(kinds).not.toContain("phone");
  });
});

describe("scanPayload (recursive, path-aware)", () => {
  it("reports the path of each hit", () => {
    const hits = scanPayload({ user: { email: "x@y.zz" }, notes: ["call 9876543210"] });
    expect(hits.find((h) => h.kind === "email")!.path).toBe("$.user.email");
    expect(hits.find((h) => h.kind === "phone")!.path).toBe("$.notes[0]");
  });
});

describe("redact / deidentify", () => {
  it("redactText replaces PII with [kind]", () => {
    expect(redactText("mail a@b.co pan ABCDE1234F")).toBe("mail [email] pan [pan]");
  });
  it("deidentifyText is stable (same input → same token)", () => {
    const a = deidentifyText("a@b.co"), b = deidentifyText("a@b.co");
    expect(a).toBe(b);
    expect(a).toMatch(/^<email:[0-9a-f]{8}>$/);
  });
  it("redactPayload deep-redacts string values, leaving structure", () => {
    const out = redactPayload({ email: "a@b.co", n: 5, nested: { ip: "10.0.0.1" } });
    expect(out).toEqual({ email: "[email]", n: 5, nested: { ip: "[ip]" } });
  });
});

describe("pluggable engine", () => {
  it("regex engine scans a payload", async () => {
    expect((await regexEngine.scan({ e: "a@b.co" })).map((m) => m.kind)).toContain("email");
  });
  it("openMed adapter falls back to regex when no sidecar is wired (not a free-tier dep)", async () => {
    const eng = openMedEngine();
    expect(eng.id).toBe("openmed");
    expect((await eng.scan({ e: "a@b.co" })).length).toBe(1);
  });
  it("openMed adapter delegates to an injected sidecar", async () => {
    const eng = openMedEngine({ scan: async () => [{ kind: "pan", value: "X", path: "$" }] });
    expect((await eng.scan({}))[0]!.kind).toBe("pan");
  });
});

describe("PiiEgressDialog gating", () => {
  const noop = () => {};
  it("renders nothing when there's no PII (caller may send straight through)", () => {
    expect(PiiEgressDialog({ matches: [], onSend: noop, onCancel: noop })).toBeNull();
  });
  it("renders a gated alertdialog when PII is present", () => {
    const el = PiiEgressDialog({ matches: [{ kind: "email", value: "a@b.co", path: "$" }], onSend: noop, onCancel: noop });
    expect(el).not.toBeNull();
    expect(el!.props.role).toBe("alertdialog");
    expect(el!.props["data-pii-egress-dialog"]).toBe("");
  });
  it("summarizeMatches groups by kind", () => {
    expect(summarizeMatches([
      { kind: "email", value: "a@b.co", path: "$" },
      { kind: "email", value: "c@d.ee", path: "$" },
      { kind: "pan", value: "ABCDE1234F", path: "$" },
    ])).toEqual([{ kind: "email", count: 2 }, { kind: "pan", count: 1 }]);
  });
});
