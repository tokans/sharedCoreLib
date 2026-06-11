/**
 * BackupPanel — the drop-in Settings section for whole-store Excel backup/restore.
 *
 * Part of the Tailwind-styled primitive kit (§4.2 policy: shared preset + theme.css +
 * the `../sharedCoreLib/src/ui/**` content glob). SSR-safe: nothing touches `document`
 * until the user clicks, and the default save path (browser blob download) is guarded.
 *
 * DI: the app constructs the {@link ExcelBackup} engine (`sharedcorelib/backup`) with
 * its own DB handles and passes it in. On Tauri, pass `save` (e.g. plugin-dialog +
 * plugin-fs) — the default anchor-download is a browser-preview fallback.
 */
import React from "react";
import { cn } from "./cn.js";
import type { ExcelBackup, ExportReport, ImportReport } from "../backup/index.js";

export interface BackupPanelProps {
  backup: ExcelBackup;
  /** Persist the exported bytes. Default: browser blob download (preview fallback). */
  save?: (bytes: Uint8Array, fileName: string) => Promise<void>;
  /** Import write mode. Default `"merge"` (upsert); `"replace"` clears each table first. */
  importMode?: "merge" | "replace";
  onExported?: (report: ExportReport) => void;
  onImported?: (report: ImportReport) => void;
  className?: string;
}

function browserDownload(bytes: Uint8Array, fileName: string): Promise<void> {
  if (typeof document === "undefined") return Promise.reject(new Error("no document — pass a save() handler"));
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return Promise.resolve();
}

export function BackupPanel({ backup, save, importMode = "merge", onExported, onImported, className }: BackupPanelProps): React.ReactElement {
  const [busy, setBusy] = React.useState<"export" | "import" | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const doExport = async (): Promise<void> => {
    setBusy("export"); setError(null); setStatus(null);
    try {
      const { bytes, report } = await backup.exportWorkbook();
      await (save ?? browserDownload)(bytes, report.fileNameHint);
      const rows = report.tables.reduce((n, t) => n + t.rows, 0);
      const hashed = report.tables.filter((t) => t.hashedColumns.length).length;
      setStatus(`Exported ${report.tables.length} tables (${rows} rows)${hashed ? `; secret fields in ${hashed} table(s) exported as hashes` : ""}.`);
      onExported?.(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File): Promise<void> => {
    setBusy("import"); setError(null); setStatus(null);
    try {
      const report = await backup.importWorkbook(await file.arrayBuffer(), { mode: importMode });
      const rows = report.tables.reduce((n, t) => n + t.rows, 0);
      const skipped = new Set(report.tables.flatMap((t) => t.skippedHashedColumns)).size;
      setStatus(`Imported ${rows} rows into ${report.tables.length} tables${skipped ? `; ${skipped} hashed secret column(s) skipped (re-enter those values)` : ""}.`);
      onImported?.(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section data-testid="core-backup-panel" className={cn("space-y-3 rounded-lg border border-border bg-card p-4", className)}>
      <div>
        <h3 className="text-sm font-semibold text-foreground">Backup &amp; restore (Excel)</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Export everything this app stores — including its shared-suite tables — to one
          .xlsx workbook (one sheet per table). Passwords and other secrets are exported
          as one-way hashes, never in the clear, and are skipped on import.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="core-backup-export"
          disabled={busy !== null}
          onClick={() => { void doExport(); }}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy === "export" ? "Exporting…" : "Export to Excel"}
        </button>
        <button
          type="button"
          data-testid="core-backup-import"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
        >
          {busy === "import" ? "Importing…" : `Import (${importMode})`}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          data-testid="core-backup-file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); }}
        />
      </div>
      {status ? <p data-testid="core-backup-status" className="text-xs text-muted-foreground">{status}</p> : null}
      {error ? <p data-testid="core-backup-error" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
