import { describe, it, expect } from "vitest";
import { nativeTextRecognizer } from "../src/recognize";

describe("nativeTextRecognizer", () => {
  const rec = nativeTextRecognizer();

  it("passes native-text/plain-text through as trusted (native-text source)", async () => {
    const a = await rec.recognize({ kind: "native-text-pdf", text: "Hb 13.5 g/dL" });
    expect(a).toEqual({ text: "Hb 13.5 g/dL", source: "native-text" });

    const b = await rec.recognize({ kind: "plain-text", text: "hello" });
    expect(b.source).toBe("native-text");
  });

  it("tags text arriving from a scan/photo kind as untrusted OCR", async () => {
    const r = await rec.recognize({ kind: "photo", text: "Crocin 500" });
    expect(r).toEqual({ text: "Crocin 500", source: "ocr" });
  });

  it("yields empty OCR text for bytes-only input (no OCR engine bundled yet)", async () => {
    const r = await rec.recognize({ kind: "scanned-pdf", bytes: new Uint8Array([1, 2, 3]) });
    expect(r).toEqual({ text: "", source: "ocr" });
  });
});
