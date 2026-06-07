import { describe, it, expect } from "vitest";
import { evaluateCondition, evaluateComputed } from "../src/libs/condition-evaluator";
import type { FieldAnswers } from "../src/libs/types";

describe("evaluateCondition — simple ops", () => {
  const f: FieldAnswers = { role: "admin", score: 7, name: "abcdef", tags: ["x", "y"], flag: true };

  it("eq / neq", () => {
    expect(evaluateCondition({ field: "role", op: "eq", value: "admin" }, f)).toBe(true);
    expect(evaluateCondition({ field: "role", op: "neq", value: "user" }, f)).toBe(true);
  });
  it("numeric comparisons", () => {
    expect(evaluateCondition({ field: "score", op: "gte", value: 5 }, f)).toBe(true);
    expect(evaluateCondition({ field: "score", op: "lt", value: 5 }, f)).toBe(false);
  });
  it("starts_with / ends_with (ends_with was previously missing)", () => {
    expect(evaluateCondition({ field: "name", op: "starts_with", value: "abc" }, f)).toBe(true);
    expect(evaluateCondition({ field: "name", op: "ends_with", value: "def" }, f)).toBe(true);
    expect(evaluateCondition({ field: "name", op: "ends_with", value: "xyz" }, f)).toBe(false);
  });
  it("in / not_in", () => {
    expect(evaluateCondition({ field: "role", op: "in", value: ["admin", "owner"] }, f)).toBe(true);
    expect(evaluateCondition({ field: "role", op: "not_in", value: ["user"] }, f)).toBe(true);
  });
  it("is_true / is_empty", () => {
    expect(evaluateCondition({ field: "flag", op: "is_true" }, f)).toBe(true);
    expect(evaluateCondition({ field: "missing", op: "is_empty" }, f)).toBe(true);
  });
});

describe("evaluateCondition — composite", () => {
  const f: FieldAnswers = { a: 1, b: 2 };
  it("all / any / not", () => {
    expect(evaluateCondition({ all: [
      { field: "a", op: "eq", value: 1 }, { field: "b", op: "eq", value: 2 },
    ] }, f)).toBe(true);
    expect(evaluateCondition({ any: [
      { field: "a", op: "eq", value: 9 }, { field: "b", op: "eq", value: 2 },
    ] }, f)).toBe(true);
    expect(evaluateCondition({ not: { field: "a", op: "eq", value: 9 } }, f)).toBe(true);
  });
});

describe("evaluateComputed — safe expression interpreter (no eval)", () => {
  it("arithmetic + comparison", () => {
    expect(evaluateComputed("fields.qty * fields.price > 1000", { qty: 3, price: 500 })).toBe(true);
  });
  it("context access and strict inequality", () => {
    expect(Boolean(evaluateComputed("context.mode !== 'signin'", {}, { mode: "signup" }))).toBe(true);
    expect(Boolean(evaluateComputed("context.mode !== 'signin'", {}, { mode: "signin" }))).toBe(false);
  });
  it("returns undefined (falsey) for malformed input, never throws", () => {
    expect(() => evaluateComputed("this is (not valid", {})).not.toThrow();
  });
});
