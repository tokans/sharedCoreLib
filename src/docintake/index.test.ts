/**
 * Every value here is invented. These tests exercise container routing and
 * password threading, which care about bytes and shapes, not about whose
 * document it is — never paste real document content into a fixture.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createDocIntake,
  detectFileKind,
  DocumentPasswordRequiredError,
  NativeCapabilityError,
  UnsupportedDocumentError,
  type NativeZipResult,
} from "./index.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
const CFB = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00]);
const TEXT = new TextEncoder().encode("a^b^c\n1^2^3");

const pdfRows = [{ page_index: 0, row_index: 0, cells: [{ text: "Date", x: 10, width: 20 }] }];

describe("detectFileKind", () => {
  it("uses the extension to break the ambiguity a container signature leaves", () => {
    // A plain .xlsx IS a zip; an encrypted .xlsx and a legacy .xls are both CFB.
    expect(detectFileKind(ZIP, "statement.xlsx")).toBe("xlsx");
    expect(detectFileKind(ZIP, "statement.zip")).toBe("zip");
    expect(detectFileKind(CFB, "statement.xlsx")).toBe("xlsx");
    expect(detectFileKind(CFB, "statement.xls")).toBe("xls");
  });

  it("trusts magic bytes over a misleading extension", () => {
    expect(detectFileKind(PDF, "statement.txt")).toBe("pdf");
  });

  it("falls back to the extension when there are no magic bytes", () => {
    expect(detectFileKind(TEXT, "26AS.txt")).toBe("txt");
    expect(detectFileKind(TEXT, "export.csv")).toBe("csv");
    expect(detectFileKind(TEXT, "mystery.bin")).toBe("unknown");
  });
});

describe("createDocIntake", () => {
  it("routes a PDF through the injected native extractor", async () => {
    const parsePdf = vi.fn().mockResolvedValue({ rows: pdfRows, password_used: "pw1" });
    const result = await createDocIntake({ parsePdf }).open(PDF, "form16.pdf", ["pw1", "pw2"]);

    expect(parsePdf).toHaveBeenCalledWith(PDF, ["pw1", "pw2"]);
    expect(result.extraction).toEqual({ kind: "pdf", rows: pdfRows });
    expect(result.sourceKind).toBe("pdf");
    expect(result.passwordUsed).toBe("pw1");
  });

  it("expands an archive and re-routes the inner file by its own kind", async () => {
    const extractZip = vi.fn().mockResolvedValue({
      filename: "26AS.txt",
      bytes: Array.from(TEXT),
      password_used: "zippw",
    } satisfies NativeZipResult);
    const result = await createDocIntake({ extractZip }).open(ZIP, "26AS.zip", ["zippw"]);

    expect(result.sourceKind).toBe("txt");
    expect(result.extraction).toEqual({ kind: "text", text: "a^b^c\n1^2^3" });
    // A text member is never separately encrypted, so the archive's own
    // password is the only one there was — and it must still be reported so
    // the caller can offer to remember it.
    expect(result.passwordUsed).toBe("zippw");
  });

  it("tries the archive's password first on the inner document", async () => {
    const extractZip = vi.fn().mockResolvedValue({
      filename: "inner.pdf",
      bytes: Array.from(PDF),
      password_used: "shared",
    });
    const parsePdf = vi.fn().mockResolvedValue({ rows: pdfRows, password_used: "shared" });
    await createDocIntake({ extractZip, parsePdf }).open(ZIP, "outer.zip", ["a", "b"]);

    // A container and its contents conventionally share a password.
    expect(parsePdf).toHaveBeenCalledWith(expect.any(Uint8Array), ["shared", "a", "b"]);
  });

  it("attaches the log to a password failure so the failing LAYER is identifiable", async () => {
    const extractZip = vi.fn().mockRejectedValue(new DocumentPasswordRequiredError());
    const intake = createDocIntake({ extractZip });

    await expect(intake.open(ZIP, "26AS.zip", ["nope"])).rejects.toMatchObject({
      name: "DocumentPasswordRequiredError",
    });

    const err = await intake.open(ZIP, "26AS.zip", ["nope"]).catch((e: DocumentPasswordRequiredError) => e);
    expect(err.log.some((e) => e.stage === "zip")).toBe(true);
    expect(err.log.some((e) => e.stage === "detect")).toBe(true);
  });

  it("refuses a PDF up front on a build with no native extractor", async () => {
    // Rather than failing somewhere deep inside a missing IPC call.
    await expect(createDocIntake({}).open(PDF, "s.pdf", [])).rejects.toBeInstanceOf(NativeCapabilityError);
    await expect(createDocIntake({}).open(ZIP, "s.zip", [])).rejects.toBeInstanceOf(NativeCapabilityError);
  });

  it("still opens a protected workbook without any native capability", async () => {
    // The xlsx/xls path is pure JS, so it must keep working on a build that
    // has no PDFium and no archive support (a mobile build, a browser preview).
    const ooxmlCrypto = {
      isEncrypted: () => true,
      decrypt: () => new Uint8Array([1, 2, 3]),
    };
    const xlsx = {
      read: () => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } }),
      utils: { sheet_to_json: <T,>() => [["Date", "Amount"], ["01/04/2026", 100]] as unknown as T[] },
    };
    const result = await createDocIntake({ ooxmlCrypto, xlsx }).open(CFB, "statement.xls", ["pw"]);

    expect(result.sourceKind).toBe("xls");
    expect(result.passwordUsed).toBe("pw");
    expect(result.extraction).toEqual({
      kind: "grid",
      grids: [{ name: "Sheet1", rows: [["Date", "Amount"], ["01/04/2026", 100]] }],
    });
  });

  it("reports an unencrypted workbook as such rather than inventing a password", async () => {
    const ooxmlCrypto = { isEncrypted: () => false, decrypt: () => new Uint8Array() };
    const xlsx = {
      read: () => ({ SheetNames: ["S"], Sheets: { S: {} } }),
      utils: { sheet_to_json: <T,>() => [] as unknown as T[] },
    };
    const result = await createDocIntake({ ooxmlCrypto, xlsx }).open(CFB, "plain.xls", ["pw"]);
    expect(result.passwordUsed).toBeNull();
  });

  it("rejects a file kind it cannot open", async () => {
    await expect(createDocIntake({}).open(new Uint8Array([9, 9]), "x.bin", [])).rejects.toBeInstanceOf(
      UnsupportedDocumentError,
    );
  });
});
