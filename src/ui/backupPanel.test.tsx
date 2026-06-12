import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackupPanel } from "./backupPanel.js";
import type { ExcelBackup } from "../backup/index.js";

/** The panel only calls the engine on user interaction — a stub is enough to render. */
const stubBackup: ExcelBackup = {
  plan: async () => [],
  exportWorkbook: async () => ({
    bytes: new Uint8Array(),
    report: { fileNameHint: "x.xlsx", tables: [], encrypted: false },
  }),
  importWorkbook: async () => ({ tables: [], unmatchedSheets: [], foreignAppSheets: [] }),
};

describe("BackupPanel (SSR-safe render)", () => {
  const html = renderToStaticMarkup(<BackupPanel backup={stubBackup} />);

  it("renders the export/import controls", () => {
    expect(html).toContain('data-testid="core-backup-panel"');
    expect(html).toContain('data-testid="core-backup-export"');
    expect(html).toContain('data-testid="core-backup-import"');
    expect(html).toContain('data-testid="core-backup-file"');
  });

  it("offers the OPTIONAL export password with the no-recovery warning", () => {
    expect(html).toContain('data-testid="core-backup-export-password"');
    expect(html).toContain('type="password"');
    expect(html).toContain("If set, Excel will ask for this password to open the file. There is NO recovery if forgotten.");
  });

  it("does NOT show the import password prompt until an encrypted file is picked", () => {
    expect(html).not.toContain('data-testid="core-backup-import-password-prompt"');
    expect(html).not.toContain('data-testid="core-backup-import-unlock"');
  });
});
