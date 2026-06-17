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
 *
 * Password protection: an OPTIONAL export password Excel-native-encrypts the workbook
 * (ECMA-376 agile; Excel prompts for it on open) — there is NO recovery if forgotten.
 * On import, an encrypted file is auto-detected ({@link isEncryptedWorkbook}) and an
 * inline prompt collects the password before the restore runs.
 */
import React from "react";
import { cn } from "./cn.js";
import { isEncryptedWorkbook } from "../backup/detect.js";
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
  const [exportPassword, setExportPassword] = React.useState("");
  /** An encrypted file was picked; its bytes wait here for the user's password. */
  const [pendingImport, setPendingImport] = React.useState<{ bytes: ArrayBuffer; name: string } | null>(null);
  const [importPassword, setImportPassword] = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);

  const doExport = async (): Promise<void> => {
    setBusy("export"); setError(null); setStatus(null);
    try {
      const password = exportPassword || undefined;
      const { bytes, report } = await backup.exportWorkbook({ password });
      await (save ?? browserDownload)(bytes, report.fileNameHint);
      const rows = report.tables.reduce((n, t) => n + t.rows, 0);
      const hashed = report.tables.filter((t) => t.hashedColumns.length).length;
      setStatus(
        `Exported ${report.tables.length} tables (${rows} rows)` +
        `${hashed ? `; secret fields in ${hashed} table(s) exported as hashes` : ""}` +
        `${report.encrypted ? "; workbook is password-protected" : ""}.`,
      );
      onExported?.(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (bytes: ArrayBuffer, password?: string): Promise<void> => {
    setBusy("import"); setError(null); setStatus(null);
    try {
      const report = await backup.importWorkbook(bytes, { mode: importMode, password });
      const rows = report.tables.reduce((n, t) => n + t.rows, 0);
      const skipped = new Set(report.tables.flatMap((t) => t.skippedHashedColumns)).size;
      setStatus(`Imported ${rows} rows into ${report.tables.length} tables${skipped ? `; ${skipped} hashed secret column(s) skipped (re-enter those values)` : ""}.`);
      setPendingImport(null);
      setImportPassword("");
      onImported?.(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onFilePicked = async (file: File): Promise<void> => {
    setError(null); setStatus(null);
    const bytes = await file.arrayBuffer();
    if (isEncryptedWorkbook(bytes)) {
      // Don't run anything yet — surface the inline password prompt instead.
      setPendingImport({ bytes, name: file.name });
      setImportPassword("");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    await doImport(bytes);
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
      <div className="space-y-1">
        <label className="block text-xs font-medium text-foreground" htmlFor="core-backup-export-password">
          Backup password <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="core-backup-export-password"
          data-testid="core-backup-export-password"
          type="password"
          autoComplete="new-password"
          value={exportPassword}
          disabled={busy !== null}
          onChange={(e) => setExportPassword(e.target.value)}
          placeholder="Leave empty for a plain workbook"
          className="w-full max-w-xs rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          If set, Excel will ask for this password to open the file. There is NO recovery if forgotten.
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
          aria-label="Backup workbook file"
          data-testid="core-backup-file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFilePicked(f); }}
        />
      </div>
      {pendingImport ? (
        <div data-testid="core-backup-import-password-prompt" className="space-y-2 rounded-md border border-border bg-background p-3">
          <p className="text-xs text-foreground">
            <span className="font-medium">{pendingImport.name}</span> is password-protected. Enter its password to import.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="core-backup-import-password"
              type="password"
              autoComplete="off"
              value={importPassword}
              disabled={busy !== null}
              onChange={(e) => setImportPassword(e.target.value)}
              placeholder="Backup password"
              className="w-full max-w-xs rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground disabled:opacity-50"
            />
            <button
              type="button"
              data-testid="core-backup-import-unlock"
              disabled={busy !== null || !importPassword}
              onClick={() => { const p = pendingImport; if (p) void doImport(p.bytes, importPassword); }}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === "import" ? "Importing…" : "Unlock & import"}
            </button>
            <button
              type="button"
              data-testid="core-backup-import-cancel"
              disabled={busy !== null}
              onClick={() => { setPendingImport(null); setImportPassword(""); setError(null); }}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {status ? <p data-testid="core-backup-status" className="text-xs text-muted-foreground">{status}</p> : null}
      {error ? <p data-testid="core-backup-error" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
