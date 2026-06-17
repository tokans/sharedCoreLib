import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTesseractRecognizer } from "../src/ocr/tesseract";
import { OcrCancelled, type TesseractRecognizerConfig } from "../src/ocr/types";

// The recognizer uses object URLs for the photo path; stub them for the node env.
beforeEach(() => {
  (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => "blob:fake");
  (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

const CONFIG: TesseractRecognizerConfig = {
  host: {} as never, // unused — provision is injected
  baseUrl: "https://h",
  langFile: "eng.traineddata.gz",
  langSha256: "abc",
  lang: "eng",
  workerPath: "/ocr/worker.min.js",
  corePath: "/ocr/",
  pdfWorkerSrc: "/ocr/pdf.worker.mjs",
};

function fakeWorker(result: { text: string; words?: { text: string; confidence: number }[] }) {
  return {
    recognize: vi.fn(async () => ({ data: result })),
    terminate: vi.fn(async () => {}),
  };
}

describe("createTesseractRecognizer", () => {
  it("passes already-known text through (native-text for plain text)", async () => {
    const rec = createTesseractRecognizer(CONFIG, {
      provision: vi.fn(),
      loadCreateWorker: vi.fn(),
    });
    const out = await rec.recognize({ kind: "plain-text", text: "Hello" });
    expect(out).toEqual({ text: "Hello", source: "native-text" });
  });

  it("OCRs a photo and returns source:ocr with per-token confidences", async () => {
    const worker = fakeWorker({ text: "ASPIRIN 75mg", words: [{ text: "ASPIRIN", confidence: 96 }] });
    const provision = vi.fn(async () => "asset://lang");
    const rec = createTesseractRecognizer(CONFIG, {
      provision,
      loadCreateWorker: async () => (async () => worker) as never,
    });

    const out = await rec.recognize({ kind: "photo", bytes: new Uint8Array([1, 2, 3]) });
    expect(out.source).toBe("ocr");
    expect(out.text).toBe("ASPIRIN 75mg");
    expect(out.perToken).toEqual([{ text: "ASPIRIN", confidence: 0.96 }]);
    expect(provision).toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalled(); // always terminated
  });

  it("rasterizes a scanned PDF and OCRs each page", async () => {
    const worker = fakeWorker({ text: "page text", words: [] });
    const rasterize = vi.fn(async () => ["c1", "c2"] as unknown as HTMLCanvasElement[]);
    const rec = createTesseractRecognizer(CONFIG, {
      provision: vi.fn(async () => "asset://lang"),
      rasterize,
      loadCreateWorker: async () => (async () => worker) as never,
    });

    const out = await rec.recognize({ kind: "scanned-pdf", bytes: new Uint8Array([9]) });
    expect(rasterize).toHaveBeenCalled();
    expect(worker.recognize).toHaveBeenCalledTimes(2); // one per page
    expect(out.text).toBe("page text\n\npage text");
    expect(out.source).toBe("ocr");
  });

  it("returns empty ocr text for bytes-less input", async () => {
    const rec = createTesseractRecognizer(CONFIG, { provision: vi.fn(), loadCreateWorker: vi.fn() });
    const out = await rec.recognize({ kind: "photo" });
    expect(out).toEqual({ text: "", source: "ocr" });
  });

  it("throws OcrCancelled when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const provision = vi.fn();
    const rec = createTesseractRecognizer(CONFIG, {
      provision,
      loadCreateWorker: vi.fn(),
      signal: ctrl.signal,
    });
    await expect(rec.recognize({ kind: "photo", bytes: new Uint8Array([1]) })).rejects.toBeInstanceOf(
      OcrCancelled,
    );
    expect(provision).not.toHaveBeenCalled();
  });
});
