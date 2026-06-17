/**
 * Dependency-free SHA-256 hex — split into its own leaf so the offline feed BUILDER
 * (`feed-builder.ts`) can hash payloads WITHOUT importing the runtime OTA engine
 * (`index.ts` → `@noble/ed25519` + zod). Uses Web Crypto only (webview + Node test env).
 */

const asSource = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Hex SHA-256 of a byte buffer. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", asSource(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
