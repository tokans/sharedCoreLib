import { describe, it, expect } from "vitest";
import {
  collapseWhitespace,
  splitLines,
  normalizeToken,
  digitsFromOcr,
  parseOcrNumber,
  stripLineMarker,
  stripFormPrefix,
  canonicalForm,
} from "../src/normalize";

describe("collapseWhitespace", () => {
  it("collapses runs and trims", () => {
    expect(collapseWhitespace("  a\t b\n c  ")).toBe("a b c");
    expect(collapseWhitespace(" x  y")).toBe("x y"); // NBSP
  });
});

describe("splitLines", () => {
  it("drops blank lines and normalizes each", () => {
    expect(splitLines("a\n\n  b  \r\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("\n\n")).toEqual([]);
  });
});

describe("normalizeToken", () => {
  it("lowercases and strips non-alphanumerics (incl. accents)", () => {
    expect(normalizeToken("CroÇin")).toBe("croin");
    expect(normalizeToken("HDL-C")).toBe("hdlc");
    expect(normalizeToken("S. Creatinine")).toBe("screatinine");
  });
});

describe("digitsFromOcr", () => {
  it("undoes letter→digit confusions", () => {
    expect(digitsFromOcr("5OO")).toBe("500");
    expect(digitsFromOcr("l3")).toBe("13");
    expect(digitsFromOcr("I2")).toBe("12");
    expect(digitsFromOcr("B8")).toBe("88");
    expect(digitsFromOcr("Z")).toBe("2");
  });
});

describe("parseOcrNumber", () => {
  it("parses messy numerics", () => {
    expect(parseOcrNumber("l.2")).toBe(1.2);
    expect(parseOcrNumber("11O")).toBe(110);
    expect(parseOcrNumber("1,250")).toBe(1250);
    expect(parseOcrNumber("O.5")).toBe(0.5);
  });
  it("returns null when there is no number", () => {
    expect(parseOcrNumber("abc")).toBeNull();
    expect(parseOcrNumber("")).toBeNull();
  });
});

describe("stripLineMarker", () => {
  it("removes numbered / bulleted / Rx markers", () => {
    expect(stripLineMarker("1. Tab Crocin")).toBe("Tab Crocin");
    expect(stripLineMarker("2) Cap Omez")).toBe("Cap Omez");
    expect(stripLineMarker("- Telma")).toBe("Telma");
    expect(stripLineMarker("Rx: Pan")).toBe("Pan");
  });
});

describe("stripFormPrefix / canonicalForm", () => {
  it("extracts and canonicalizes a leading dosage form", () => {
    expect(stripFormPrefix("Tab. Crocin 500mg")).toEqual({ rest: "Crocin 500mg", form: "tablet" });
    expect(stripFormPrefix("Cap Omez")).toEqual({ rest: "Omez", form: "capsule" });
    expect(stripFormPrefix("Syrup Calpol")).toEqual({ rest: "Calpol", form: "syrup" });
  });
  it("leaves a line with no form prefix untouched", () => {
    expect(stripFormPrefix("Crocin 500mg")).toEqual({ rest: "Crocin 500mg", form: null });
  });
  it("maps form words to canonical forms", () => {
    expect(canonicalForm("Inj.")).toBe("injection");
    expect(canonicalForm("oint")).toBe("ointment");
    expect(canonicalForm("susp")).toBe("suspension");
  });
});
