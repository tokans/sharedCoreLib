/**
 * Password-protected spreadsheet handling, and reading a workbook down to
 * plain cell grids.
 *
 * Deliberately does NOT reuse `sharedcorelib/backup`'s `isEncryptedWorkbook`:
 * that is a bare OLE/CFB magic-byte test, which is correct for its own use
 * case (that engine only ever emits `.xlsx`, so "is CFB" really does mean "is
 * our encrypted wrapper"). Here a plain, UNENCRYPTED legacy `.xls` is a valid
 * input and is also an OLE/CFB container, so the bare signature check would
 * flag every ordinary `.xls` upload as password-protected. `officecrypto-tool`
 * parses the CFB directory for a real `EncryptionInfo` stream (OOXML) or a
 * BIFF `FILEPASS` record (legacy) instead, so a plain `.xls` comes back false.
 *
 * Everything heavy is injected or lazy-imported: an app that never opens a
 * spreadsheet loads neither SheetJS nor the crypto module.
 */
import { DocumentPasswordRequiredError } from "./errors.js";

/** The slice of SheetJS (`xlsx`) needed to read a workbook into grids. */
export interface XlsxReadModule {
  read(data: ArrayBuffer | Uint8Array, opts?: Record<string, unknown>): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json<T>(ws: unknown, opts?: Record<string, unknown>): T[];
  };
}

/** The slice of `officecrypto-tool` needed to open a protected workbook. */
export interface WorkbookCryptoModule {
  isEncrypted(input: Uint8Array): boolean;
  decrypt(input: Uint8Array, opts: { password: string }): Uint8Array | Promise<Uint8Array>;
}

export interface SheetGrid {
  name: string;
  rows: (string | number | null)[][];
}

function toBuffer(bytes: Uint8Array): Uint8Array {
  const g = globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } };
  if (!g.Buffer) {
    throw new Error(
      "Password-protected spreadsheets need a Buffer implementation in this runtime — " +
        "add a bundler Buffer polyfill or inject config.ooxmlCrypto.",
    );
  }
  return g.Buffer.from(bytes);
}

/** Adapts the lazy-imported CJS module (default-vs-named interop varies by bundler). */
function adaptCrypto(mod: unknown): WorkbookCryptoModule {
  const m = mod as { default?: unknown; decrypt?: unknown };
  const impl = (typeof m.decrypt === "function" ? m : m.default) as {
    isEncrypted(b: Uint8Array): boolean;
    decrypt(b: Uint8Array, o: { password: string }): Uint8Array | Promise<Uint8Array>;
  };
  return {
    isEncrypted: (input) => impl.isEncrypted(toBuffer(input)),
    decrypt: async (input, opts) => new Uint8Array(await impl.decrypt(toBuffer(input), opts)),
  };
}

async function resolveCrypto(injected?: WorkbookCryptoModule): Promise<WorkbookCryptoModule> {
  if (injected) return injected;
  return adaptCrypto(await import("officecrypto-tool"));
}

async function resolveXlsx(injected?: XlsxReadModule): Promise<XlsxReadModule> {
  if (injected) return injected;
  return (await import("xlsx")) as unknown as XlsxReadModule;
}

/** True only for a genuinely password-protected xlsx/xls, not any OLE/CFB file. */
export async function isEncryptedWorkbook(bytes: Uint8Array, crypto?: WorkbookCryptoModule): Promise<boolean> {
  return (await resolveCrypto(crypto)).isEncrypted(bytes);
}

/**
 * Tries each candidate password in order. Returns the bytes untouched (with
 * `passwordUsed: null`) when the workbook isn't encrypted at all, and throws
 * `DocumentPasswordRequiredError` when it is but nothing opened it.
 */
export async function decryptWorkbookWithCandidates(
  bytes: Uint8Array,
  candidates: string[],
  crypto?: WorkbookCryptoModule,
): Promise<{ bytes: Uint8Array; passwordUsed: string | null }> {
  const impl = await resolveCrypto(crypto);
  if (!impl.isEncrypted(bytes)) return { bytes, passwordUsed: null };

  for (const candidate of candidates) {
    try {
      return { bytes: await impl.decrypt(bytes, { password: candidate }), passwordUsed: candidate };
    } catch {
      // Wrong password — try the next candidate.
    }
  }
  throw new DocumentPasswordRequiredError();
}

/**
 * Reads a workbook into one grid per sheet. `blankrows: false` is deliberate:
 * a spreadsheet's trailing blank rows are layout, not structure, and keeping
 * them would separate blocks the sheet meant to keep together.
 */
export async function readSheetGrids(bytes: Uint8Array, xlsx?: XlsxReadModule): Promise<SheetGrid[]> {
  const impl = await resolveXlsx(xlsx);
  const wb = impl.read(bytes, { type: "array", cellDates: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: impl.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    }),
  }));
}
