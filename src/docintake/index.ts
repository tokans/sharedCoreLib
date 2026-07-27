/**
 * `sharedcorelib/docintake` — getting bytes of *some* document into a uniform,
 * structurable extraction, whatever container it arrived in.
 *
 * One entry point handles the shapes real portals and banks actually issue: a
 * direct PDF, a password-protected zip (the common "download as zip" wire
 * format — expanded, then its inner file routed back through the same logic),
 * a password-protected xlsx/xls, or a delimited text export. It answers only
 * "what is this file and how do I open it", never "what does it mean" —
 * structure is `@scandoc/core/docmodel`'s job and meaning is the app's.
 *
 * Native capabilities are INJECTED, not imported (CONTRACT §5). PDF text
 * extraction and archive expansion are host concerns — a Tauri command, a
 * WASM build, a test double — and keeping them behind `config.parsePdf` /
 * `config.extractZip` is what lets this module stay free of Tauri, run under
 * plain vitest, and degrade honestly on a build that lacks them rather than
 * failing deep inside an IPC call.
 */
import { DocumentPasswordRequiredError, NativeCapabilityError, UnsupportedDocumentError } from "./errors.js";
import { detectFileKind, type FileKind } from "./fileKind.js";
import { createParseLog, type ParseLog, type ParseLogEntry } from "./parseLog.js";
import {
  decryptWorkbookWithCandidates,
  readSheetGrids,
  type SheetGrid,
  type WorkbookCryptoModule,
  type XlsxReadModule,
} from "./workbook.js";

export { detectFileKind, type FileKind } from "./fileKind.js";
export { createParseLog, type ParseLog, type ParseLogEntry } from "./parseLog.js";
export { DocumentPasswordRequiredError, NativeCapabilityError, UnsupportedDocumentError } from "./errors.js";
export {
  decryptWorkbookWithCandidates,
  isEncryptedWorkbook,
  readSheetGrids,
  type SheetGrid,
  type WorkbookCryptoModule,
  type XlsxReadModule,
} from "./workbook.js";

/** One geometry-reconstructed row from a native PDF extractor (serde snake_case). */
export interface NativeTableRow {
  page_index: number;
  row_index: number;
  cells: { text: string; x: number; width: number }[];
}

export interface NativePdfResult {
  rows: NativeTableRow[];
  /** The candidate that opened the document, or null if it wasn't encrypted. */
  password_used: string | null;
}

export interface NativeZipResult {
  filename: string;
  bytes: ArrayLike<number>;
  password_used: string | null;
}

/**
 * What came out of a document, in the three shapes anything can reduce to.
 *
 * Structurally matches `@scandoc/core/docmodel`'s `fromExtraction` input, so
 * the two packages compose without either depending on the other — the app
 * passes this straight through.
 */
export type Extraction =
  | { kind: "pdf"; rows: NativeTableRow[] }
  | { kind: "grid"; grids: SheetGrid[] }
  | { kind: "text"; text: string };

export interface IntakeResult {
  extraction: Extraction;
  /** What the document turned out to BE, after unwrapping any container. */
  sourceKind: Exclude<FileKind, "zip" | "unknown">;
  /** The inner filename when the input was an archive, else the original. */
  filename: string;
  /**
   * The password that opened this document, for a "remember this password"
   * affordance. For a text file inside an encrypted zip this is the ZIP's
   * password — the text itself is never separately encrypted, so that is the
   * only password there was.
   */
  passwordUsed: string | null;
  log: ParseLogEntry[];
}

export interface DocIntakeConfig {
  /** Native PDF text extraction. Omit on a build without it — a PDF then
   *  fails with `NativeCapabilityError` before any work is attempted. */
  parsePdf?: (bytes: Uint8Array, passwordCandidates: string[]) => Promise<NativePdfResult>;
  /** Native archive expansion, returning the single most relevant entry. */
  extractZip?: (bytes: Uint8Array, passwordCandidates: string[]) => Promise<NativeZipResult>;
  /** SheetJS override; defaults to the lib's own lazy-imported `xlsx`. */
  xlsx?: XlsxReadModule;
  /** `officecrypto-tool` override; defaults to the lib's own, lazy-imported. */
  ooxmlCrypto?: WorkbookCryptoModule;
}

export interface DocIntake {
  open(
    bytes: Uint8Array,
    filename: string,
    passwordCandidates: string[],
    log?: ParseLog,
  ): Promise<IntakeResult>;
}

export function createDocIntake(config: DocIntakeConfig = {}): DocIntake {
  return {
    async open(bytes, filename, passwordCandidates, log = createParseLog()) {
      let workingBytes = bytes;
      let workingName = filename;
      let candidates = passwordCandidates;
      let kind = detectFileKind(workingBytes, workingName);
      log.log("detect", `"${filename}" looks like: ${kind}`);

      // Tracked separately so the text branch can still report the archive's
      // password: a plain-text member is never encrypted in its own right.
      let zipPasswordUsed: string | null = null;

      if (kind === "zip") {
        if (!config.extractZip) {
          log.log("zip", "blocked: this build has no native archive support");
          throw new NativeCapabilityError("zip");
        }
        log.log("zip", `trying ${candidates.length} candidate password(s) against the archive`);
        let extracted: NativeZipResult;
        try {
          extracted = await config.extractZip(workingBytes, candidates);
        } catch (err) {
          if (err instanceof DocumentPasswordRequiredError) {
            log.log("zip", `none of ${candidates.length} candidate(s) opened the archive`);
            throw new DocumentPasswordRequiredError(log.entries);
          }
          throw err;
        }
        log.log(
          "zip",
          `extracted "${extracted.filename}"${extracted.password_used ? ` (password matched)` : " (archive wasn't encrypted)"}`,
        );
        workingBytes = new Uint8Array(Array.from(extracted.bytes));
        workingName = extracted.filename;
        zipPasswordUsed = extracted.password_used;
        // A container and its contents conventionally share a password, so
        // the one that worked is tried first on the inner file.
        if (extracted.password_used) candidates = [extracted.password_used, ...candidates];
        kind = detectFileKind(workingBytes, workingName);
        log.log("detect", `inner file "${workingName}" looks like: ${kind}`);
      }

      if (kind === "pdf") {
        if (!config.parsePdf) {
          log.log("pdf", "blocked: this build has no native PDF support");
          throw new NativeCapabilityError("pdf");
        }
        log.log("pdf", `trying ${candidates.length} candidate password(s) against the PDF`);
        let result: NativePdfResult;
        try {
          result = await config.parsePdf(workingBytes, candidates);
        } catch (err) {
          if (err instanceof DocumentPasswordRequiredError) {
            log.log("pdf", `none of ${candidates.length} candidate(s) opened the PDF`);
            throw new DocumentPasswordRequiredError(log.entries);
          }
          throw err;
        }
        log.log(
          "pdf",
          `opened${result.password_used ? " (password matched)" : " (PDF wasn't encrypted)"}; reconstructed ${result.rows.length} row(s)`,
        );
        return {
          extraction: { kind: "pdf", rows: result.rows },
          sourceKind: "pdf",
          filename: workingName,
          passwordUsed: result.password_used ?? zipPasswordUsed,
          log: log.entries,
        };
      }

      if (kind === "xlsx" || kind === "xls") {
        log.log("workbook", `trying ${candidates.length} candidate password(s) against the workbook`);
        let decrypted: { bytes: Uint8Array; passwordUsed: string | null };
        try {
          decrypted = await decryptWorkbookWithCandidates(workingBytes, candidates, config.ooxmlCrypto);
        } catch (err) {
          if (err instanceof DocumentPasswordRequiredError) {
            log.log("workbook", `none of ${candidates.length} candidate(s) opened the workbook`);
            throw new DocumentPasswordRequiredError(log.entries);
          }
          throw err;
        }
        log.log("workbook", decrypted.passwordUsed ? "decrypted (password matched)" : "was not encrypted");
        const grids = await readSheetGrids(decrypted.bytes, config.xlsx);
        log.log("workbook", `read ${grids.length} sheet(s)`);
        return {
          extraction: { kind: "grid", grids },
          sourceKind: kind,
          filename: workingName,
          passwordUsed: decrypted.passwordUsed ?? zipPasswordUsed,
          log: log.entries,
        };
      }

      if (kind === "txt" || kind === "csv") {
        const text = new TextDecoder("utf-8").decode(workingBytes);
        log.log("text", `read ${text.length} character(s) of plain text`);
        return {
          extraction: { kind: "text", text },
          sourceKind: kind,
          filename: workingName,
          passwordUsed: zipPasswordUsed,
          log: log.entries,
        };
      }

      throw new UnsupportedDocumentError(workingName);
    },
  };
}
