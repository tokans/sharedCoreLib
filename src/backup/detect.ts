/**
 * Pure workbook-format detection — no parsing, no lazy imports, no heavy deps.
 *
 * Split into its own leaf so the UI (`BackupPanel`) can detect an encrypted file
 * WITHOUT pulling the whole Excel backup engine (`backup/index.ts` → xlsx /
 * officecrypto / schema hashing) into its module graph.
 */

/** OLE/CFB compound-file signature — what an encrypted OOXML container starts with (a plain `.xlsx` starts with zip's `PK`). */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/**
 * Whether `bytes` are a password-protected workbook (an OLE/CFB encryption container)
 * rather than a plain `.xlsx` zip. Pure signature check — no parsing, no lazy imports —
 * so UIs can decide to prompt for a password BEFORE calling `importWorkbook`.
 */
export function isEncryptedWorkbook(bytes: ArrayBuffer | Uint8Array): boolean {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.length >= CFB_SIGNATURE.length && CFB_SIGNATURE.every((b, i) => u8[i] === b);
}
