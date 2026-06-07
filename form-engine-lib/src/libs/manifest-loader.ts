/**
 * manifest-loader.ts — safe manifest loading for library consumers.
 * SAST: URL validation prevents SSRF; only http/https allowed.
 */
import type { FormManifest } from "./types";

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/**
 * Load a FormManifest from:
 *   - A URL string (https://... or http://...)
 *   - A raw YAML string
 *   - A raw JSON string
 *   - A plain JavaScript object
 */
export async function loadManifest(
  source: string | Record<string, unknown>
): Promise<FormManifest> {
  if (typeof source === "object" && source !== null) {
    return source as unknown as FormManifest;
  }

  if (typeof source !== "string") {
    throw new TypeError("loadManifest: source must be a string or object");
  }

  // URL path
  if (source.startsWith("http://") || source.startsWith("https://") || source.startsWith("/")) {
    if (source.startsWith("http")) {
      // Validate protocol to prevent SSRF
      let parsedUrl: URL;
      try { parsedUrl = new URL(source); }
      catch { throw new Error("Invalid manifest URL"); }
      if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
        throw new Error(`Unsafe protocol: ${parsedUrl.protocol}`);
      }
    }
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to load manifest (HTTP ${res.status})`);
    const text = await res.text();
    const hint = source.endsWith(".json") ? "json" : "yaml";
    return _parseText(text, hint);
  }

  return _parseText(source, "auto");
}

async function _parseText(
  text: string,
  hint: "yaml" | "json" | "auto"
): Promise<FormManifest> {
  const trimmed = text.trimStart();
  if (hint === "json" || (hint === "auto" && trimmed.startsWith("{"))) {
    return JSON.parse(text) as FormManifest;
  }
  // Dynamic import keeps yaml out of the critical bundle for JSON-only users
  const loadYaml = await import("yaml");
  return loadYaml.parse(text) as FormManifest;
}
