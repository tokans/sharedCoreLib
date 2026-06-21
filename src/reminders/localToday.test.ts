import { describe, it, expect } from "vitest";
import { localToday, todayISO } from "./index.js";

describe("localToday / todayISO", () => {
  it("returns the LOCAL calendar date as zero-padded YYYY-MM-DD", () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(localToday()).toBe(expected);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(localToday())).toBe(true);
  });

  it("todayISO is the same function (alias)", () => {
    expect(todayISO).toBe(localToday);
    expect(todayISO()).toBe(localToday());
  });
});
