import { describe, it, expect } from "vitest";
import { validateField } from "../src/libs/condition-evaluator";
import type { FormField } from "../src/libs/types";

const field = (f: Partial<FormField> & { id: string; type: string }) => f as unknown as FormField;

describe("validateField", () => {
  it("flags required empty field", () => {
    const errs = validateField(field({ id: "name", type: "text", label: "Name", required: true }), "", {});
    expect(errs.length).toBe(1);
  });

  it("passes a filled required field", () => {
    const errs = validateField(field({ id: "name", type: "text", required: true }), "Jane", {});
    expect(errs).toEqual([]);
  });

  it("enforces text min/max length and pattern", () => {
    const f = field({ id: "code", type: "text", min_length: 3, max_length: 5, pattern: "^[a-z]+$" });
    expect(validateField(f, "ab", {}).length).toBeGreaterThan(0);   // too short
    expect(validateField(f, "abcdef", {}).length).toBeGreaterThan(0); // too long
    expect(validateField(f, "AB3", {}).length).toBeGreaterThan(0);    // pattern fail
    expect(validateField(f, "abcd", {})).toEqual([]);
  });

  it("enforces number min/max and signed", () => {
    const f = field({ id: "n", type: "number", min: 0, max: 100, signed: false });
    expect(validateField(f, 150, {}).length).toBeGreaterThan(0);
    expect(validateField(f, -5, {}).length).toBeGreaterThan(0);
    expect(validateField(f, 50, {})).toEqual([]);
  });

  it("REGRESSION: a rule-based `required` fires on empty even when field.required is unset", () => {
    const f = field({
      id: "nick", type: "text",
      validation: { rules: [{ type: "required", message: "Nick is required" }] },
    } as any);
    const errs = validateField(f, "", {});
    expect(errs).toContain("Nick is required");
  });
});
