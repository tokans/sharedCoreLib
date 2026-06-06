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
