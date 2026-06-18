import type { PluginOption } from "vite";

/** Vite wiring that makes the Excel backup-password path work in a browser/webview build. */
export interface BackupViteConfig {
  /** Spread into your Vite `plugins` array. */
  plugins: PluginOption[];
  /** Merge into `resolve.alias` (object form), or map to array entries for the array form. */
  alias: Record<string, string>;
  /** Suggested `build.chunkSizeWarningLimit` — the lazy officecrypto chunk is ~950 KB. */
  chunkSizeWarningLimit: number;
  /**
   * Whether `id` belongs to the backup-password subtree (officecrypto + Node polyfills).
   * Apps whose `manualChunks` has a catch-all should early-return `undefined` for these
   * so the subtree stays on rolldown's lazy default split (off first paint).
   */
  isBackupModule(id: string): boolean;
}

/** Standalone form of {@link BackupViteConfig.isBackupModule}. */
export function isBackupModule(id: string): boolean;

/**
 * Build wiring for the optional Excel backup password (`sharedcorelib/backup`):
 * officecrypto-tool is Node-targeted (needs Buffer/crypto/stream/...), so a browser/
 * webview build must polyfill them or the password export/import throws at runtime.
 * See ./backup-polyfills.mjs for the full rationale.
 */
export function backupVite(): BackupViteConfig;
