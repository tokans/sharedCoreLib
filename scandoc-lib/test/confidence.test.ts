import { describe, it, expect } from "vitest";
import {
  tierByConfidence,
  requiresConfirmation,
  AUTO_THRESHOLD,
  DISAMBIGUATE_THRESHOLD,
} from "../src/confidence";

describe("tierByConfidence", () => {
  it("routes by the two thresholds", () => {
    expect(tierByConfidence(1)).toBe("auto");
    expect(tierByConfidence(AUTO_THRESHOLD)).toBe("auto");
    expect(tierByConfidence(0.89)).toBe("disambiguate");
    expect(tierByConfidence(DISAMBIGUATE_THRESHOLD)).toBe("disambiguate");
    expect(tierByConfidence(0.59)).toBe("manual");
    expect(tierByConfidence(0)).toBe("manual");
  });
  it("clamps out-of-range input", () => {
    expect(tierByConfidence(2)).toBe("auto");
    expect(tierByConfidence(-1)).toBe("manual");
  });
});

describe("requiresConfirmation", () => {
  it("requires confirmation for safety-critical fields read by OCR", () => {
    expect(requiresConfirmation("ocr", true)).toBe(true);
  });
  it("does not require it for native-text or human sources, even if safety-critical", () => {
    expect(requiresConfirmation("native-text", true)).toBe(false);
    expect(requiresConfirmation("human", true)).toBe(false);
  });
  it("does not gate non-safety-critical fields", () => {
    expect(requiresConfirmation("ocr", false)).toBe(false);
  });
});
