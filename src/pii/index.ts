/**
 * PII egress guard — app-agnostic. Scan an OUTGOING payload for personal data, redact or
 * de-identify it, and (via {@link PiiEgressDialog}) make the user confirm before anything
 * leaves the device. Used by `account` and by the paid apps' cloud leg (invariant 7: a PII
 * guard on every cloud egress).
 *
 * Two layers:
 *   - **Deterministic regex engine** (default, free, offline) — emails, phones, India PAN
 *     and Aadhaar, credit cards (Luhn-checked), IPs. No LLM (a hard suite constraint).
 *   - **Pluggable {@link PiiEngine}** — an app may inject a stronger engine (the OpenMed
 *     adapter runs via the PAID Python sidecar; it is NOT a free-tier dependency).
 *
 * Pure + SSR-safe: no `window`, no Tauri, no network at import.
 */

export type PiiKind = "email" | "phone" | "pan" | "aadhaar" | "creditcard" | "ip";

export interface PiiMatch {
  kind: PiiKind;
  value: string;
  /** Path within the scanned object (e.g. `$.user.email`), or `$` for a bare string. */
  path: string;
}

const luhnOk = (digits: string): boolean => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return digits.length >= 13 && sum % 10 === 0;
};

interface Detector { kind: PiiKind; re: RegExp; accept?: (m: string) => boolean }

// Order matters: more-specific / longer patterns first so overlap-suppression keeps them
// (a 16-digit card must win over the 12-digit Aadhaar prefix it contains).
const DETECTORS: Detector[] = [
  { kind: "email", re: /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi },
  { kind: "pan", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  { kind: "creditcard", re: /\b(?:\d[ -]?){13,19}\b/g, accept: (m) => luhnOk(m.replace(/\D/g, "")) },
  { kind: "aadhaar", re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g, accept: (m) => m.replace(/\D/g, "").length === 12 },
  { kind: "ip", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, accept: (m) => m.split(".").every((o) => +o <= 255) },
  { kind: "phone", re: /(?:\+?\d{1,3}[\s-]?)?(?:\d[\s-]?){9,12}\d/g, accept: (m) => { const d = m.replace(/\D/g, ""); return d.length >= 10 && d.length <= 13; } },
];

/** Scan a single string for PII (overlap-aware: an Aadhaar/card isn't double-counted as a phone). */
export function scanText(text: string, path = "$"): PiiMatch[] {
  const out: PiiMatch[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const det of DETECTORS) {
    det.re.lastIndex = 0;
    for (let m = det.re.exec(text); m; m = det.re.exec(text)) {
      const value = m[0];
      const s = m.index, e = s + value.length;
      if (overlaps(s, e)) continue;
      if (det.accept && !det.accept(value)) continue;
      taken.push([s, e]);
      out.push({ kind: det.kind, value, path });
    }
  }
  return out;
}

/** Recursively scan an object's string values, reporting the JSON-ish path of each hit. */
export function scanPayload(payload: unknown, path = "$"): PiiMatch[] {
  if (typeof payload === "string") return scanText(payload, path);
  if (Array.isArray(payload)) return payload.flatMap((v, i) => scanPayload(v, `${path}[${i}]`));
  if (payload && typeof payload === "object") {
    return Object.entries(payload as Record<string, unknown>).flatMap(([k, v]) => scanPayload(v, `${path}.${k}`));
  }
  return [];
}

/** Replace every PII run in a string with `[kind]`. */
export function redactText(text: string): string {
  let out = text;
  for (const m of scanText(text).sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(m.value).join(`[${m.kind}]`);
  }
  return out;
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h.toString(16).padStart(8, "0");
};

/** De-identify: replace each PII run with a stable pseudonym `<kind:hash8>` (same input → same token). */
export function deidentifyText(text: string): string {
  let out = text;
  for (const m of scanText(text).sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(m.value).join(`<${m.kind}:${fnv(m.value)}>`);
  }
  return out;
}

/** Deep-redact an object's string values (returns a new object; non-strings untouched). */
export function redactPayload<T>(payload: T): T {
  if (typeof payload === "string") return redactText(payload) as unknown as T;
  if (Array.isArray(payload)) return payload.map((v) => redactPayload(v)) as unknown as T;
  if (payload && typeof payload === "object") {
    return Object.fromEntries(Object.entries(payload as Record<string, unknown>).map(([k, v]) => [k, redactPayload(v)])) as T;
  }
  return payload;
}

// ── Pluggable engine ────────────────────────────────────────────────────────

export interface PiiEngine {
  readonly id: string;
  scan(payload: unknown): Promise<PiiMatch[]>;
}

/** The default deterministic, offline, free engine. */
export const regexEngine: PiiEngine = {
  id: "regex",
  scan: async (payload) => scanPayload(payload),
};

/**
 * OpenMed adapter stub — a stronger clinical-PII engine that runs via the PAID Python
 * sidecar. NOT a free-tier dependency: if no sidecar is wired it falls back to the regex
 * engine so callers degrade safely. The real adapter is implemented in the paid apps.
 */
export function openMedEngine(sidecar?: { scan(payload: unknown): Promise<PiiMatch[]> }): PiiEngine {
  return {
    id: "openmed",
    scan: async (payload) => (sidecar ? sidecar.scan(payload) : regexEngine.scan(payload)),
  };
}

export * from "./dialog.js";
