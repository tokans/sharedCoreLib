import type { ParseLogEntry } from "./parseLog.js";

/**
 * Thrown when a document is password-protected and none of the candidate
 * passwords matched.
 *
 * Carries the parsing log accumulated up to the failure, because a zip and
 * the file inside it can each demand their own password — without the log the
 * message alone can't say WHICH layer rejected the attempt, and that
 * diagnostic is otherwise lost on every failed try.
 */
export class DocumentPasswordRequiredError extends Error {
  log: ParseLogEntry[];
  constructor(log: ParseLogEntry[] = []) {
    super("This document is password-protected and none of the candidate passwords matched.");
    this.name = "DocumentPasswordRequiredError";
    this.log = log;
  }
}

/**
 * Thrown when a branch needs a native capability the host hasn't supplied —
 * PDF text extraction or archive expansion, both of which are injected
 * (`config.parsePdf` / `config.extractZip`) rather than imported.
 *
 * This is one error rather than separate "browser preview" and "mobile" cases
 * on purpose: from the library's side they're indistinguishable, and the host
 * that omitted the seam is the only party that knows why. `capability` lets
 * the host phrase the message for its own situation.
 */
export class NativeCapabilityError extends Error {
  capability: "pdf" | "zip";
  constructor(capability: "pdf" | "zip", message?: string) {
    super(
      message ??
        `This document needs native ${capability === "pdf" ? "PDF" : "archive"} support, which isn't available in this build.`,
    );
    this.name = "NativeCapabilityError";
    this.capability = capability;
  }
}

/** Thrown for a file whose detected kind this intake can't open at all. */
export class UnsupportedDocumentError extends Error {
  constructor(filename: string) {
    super(`Unsupported file type for "${filename}" — expected a PDF, ZIP, Excel workbook, or text file.`);
    this.name = "UnsupportedDocumentError";
  }
}
