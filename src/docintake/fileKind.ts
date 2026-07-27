export type FileKind = "pdf" | "zip" | "xlsx" | "xls" | "txt" | "csv" | "unknown";

/**
 * Detects a document's real format from its magic bytes, falling back to the
 * filename extension only where the bytes are genuinely ambiguous.
 *
 * The ambiguity is not incidental: a plain `.xlsx` IS a zip (OOXML), and an
 * encrypted `.xlsx` and a legacy `.xls` are BOTH OLE/CFB containers. In each
 * case the signature identifies the container, not the payload, so the
 * extension is the only remaining discriminator. Plain text has no magic
 * bytes at all, so extension is its only signal.
 */
export function detectFileKind(bytes: Uint8Array, filename: string): FileKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf"; // "%PDF"
  }
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // "PK.." — a zip container. A plain .xlsx is one too; anything else with
    // this signature is a genuine archive.
    return ext === "xlsx" ? "xlsx" : "zip";
  }
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    // OLE/CFB — legacy .xls (encrypted or not), or an encrypted .xlsx.
    return ext === "xlsx" ? "xlsx" : "xls";
  }

  if (ext === "pdf") return "pdf";
  if (ext === "zip") return "zip";
  if (ext === "xlsx") return "xlsx";
  if (ext === "xls") return "xls";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  return "unknown";
}
