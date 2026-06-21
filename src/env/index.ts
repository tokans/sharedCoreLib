/**
 * Environment detection helpers — fully generic, no app config.
 *
 * Distinguishes the Tauri webview (where the SQL/Stronghold/FS plugins exist)
 * from a plain browser (`npm run dev`, Vitest/jsdom). App code gates Tauri-only
 * paths with these so pages can still render in a browser preview.
 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const isWeb = (): boolean => !isTauri();

export const isMobile = async (): Promise<boolean> => {
  if (!isTauri()) return false;
  const { platform } = await import("@tauri-apps/plugin-os");
  const p = platform();
  return p === "ios" || p === "android";
};

export const isDesktop = async (): Promise<boolean> => {
  if (!isTauri()) return false;
  return !(await isMobile());
};

/** URL schemes the external opener is allowed to launch (fails closed on anything else). */
const SAFE_EXTERNAL_SCHEMES = new Set(["https:", "tel:", "mailto:"]);

/**
 * Open an external URL via the OS (Tauri desktop, `@tauri-apps/plugin-opener`) or a new browser
 * tab (web / dev preview). Shared so apps stop re-implementing it. As JS-layer defence-in-depth
 * the scheme is validated here (only https:/tel:/mailto:) so the fallback path fails closed
 * regardless of any Tauri capability allow-list — `javascript:`/`data:` etc. are dropped.
 * The opener plugin is dynamically imported so the web bundle never needs it; it is an OPTIONAL
 * peer dependency (apps that call this in Tauri must provide `@tauri-apps/plugin-opener`).
 */
export const openExternal = async (url: string): Promise<void> => {
  let safe = false;
  try {
    safe = SAFE_EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    safe = false;
  }
  if (!safe) return;
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      /* fall through to the browser opener */
    }
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
};
