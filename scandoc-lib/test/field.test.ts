import { describe, it, expect } from "vitest";
import { fieldFrom } from "../src/field";

describe("fieldFrom", () => {
  it("tiers the confidence and starts unverified", () => {
    const f = fieldFrom("Paracetamol", 0.95, { source: "ocr" });
    expect(f.value).toBe("Paracetamol");
    expect(f.tier).toBe("auto");
    expect(f.verified).toBe(false);
    expect(f.candidates).toEqual([]);
  });

  it("marks a safety-critical OCR field confirm-required", () => {
    const f = fieldFrom("Insulin", 0.99, { source: "ocr", safetyCritical: true });
    expect(f.confirmRequired).toBe(true);
  });

  it("trusts native text even when safety-critical", () => {
    const f = fieldFrom("Insulin", 0.99, { source: "native-text", safetyCritical: true });
    expect(f.confirmRequired).toBe(false);
  });

  it("carries domain-shaped candidates and a null value when nothing matched", () => {
    const f = fieldFrom<string>(null, 0.4, {
      source: "ocr",
      candidates: [{ value: "Metformin", score: 0.55 }],
    });
    expect(f.value).toBeNull();
    expect(f.tier).toBe("manual");
    expect(f.candidates).toEqual([{ value: "Metformin", score: 0.55 }]);
  });
});
