/**
 * Download-once provisioning for OCR language data.
 *
 * Flow (idempotent): if the language file is already cached and its SHA-256 still
 * matches, reuse it; otherwise download it via the app's `OcrAssetHost`, verify the
 * bytes BEFORE writing (so a corrupt/tampered file never persists), cache it, and
 * return a fetchable local URL for the OCR worker. Verification uses Web Crypto
 * (`crypto.subtle.digest`), available in both the webview and Node.
 *
 * INVARIANT (suite #1/#2): the only network hop is the app-allowlisted download, and
 * the bytes are integrity-checked against a baked hash before use.
 */
import type { OcrAssetHost, DownloadOptions } from "./types";
import { OcrIntegrityError } from "./types";

/** Lowercase hex SHA-256 of `bytes` using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `.slice()` copies exactly this view's bytes into a fresh, non-shared ArrayBuffer,
  // so a subarray (non-zero byteOffset) hashes its intended bytes, not the backing one.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice() as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ProvisionLangConfig {
  host: OcrAssetHost;
  baseUrl: string;
  langFile: string;
  langSha256: string;
}

/** Has the language data already been downloaded + cached on this device? */
export async function isLangProvisioned(cfg: ProvisionLangConfig): Promise<boolean> {
  if (!(await cfg.host.hasCached(cfg.langFile))) return false;
  try {
    const bytes = await cfg.host.readCached(cfg.langFile);
    return (await sha256Hex(bytes)) === cfg.langSha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Ensure the language data is present + verified, downloading it once if needed.
 * Returns a fetchable URL (for tesseract `langPath`) of the cached file. Throws
 * `OcrIntegrityError` on hash mismatch and never writes a mismatched file.
 */
export async function provisionLang(
  cfg: ProvisionLangConfig,
  opts: DownloadOptions = {},
): Promise<string> {
  const want = cfg.langSha256.toLowerCase();

  // Reuse a valid cached copy without touching the network.
  if (await cfg.host.hasCached(cfg.langFile)) {
    const cached = await cfg.host.readCached(cfg.langFile);
    if ((await sha256Hex(cached)) === want) return cfg.host.cacheDirUrl();
    // Fall through to re-download if the cached copy is stale/corrupt.
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/${cfg.langFile}`;
  const bytes = await cfg.host.download(url, opts);

  const got = await sha256Hex(bytes);
  if (got !== want) throw new OcrIntegrityError(want, got);

  await cfg.host.writeCached(cfg.langFile, bytes);
  return cfg.host.cacheDirUrl();
}
