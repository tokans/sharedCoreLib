import { describe, it, expect } from "vitest";
import { levenshtein, similarity, rankMatches } from "../src/fuzzy";

describe("levenshtein", () => {
  it("is 0 for identical strings and handles empties", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts single edits (sub / insert / delete)", () => {
    expect(levenshtein("crocin", "croin")).toBe(1); // delete
    expect(levenshtein("metformin", "metf0rmin")).toBe(1); // substitute
    expect(levenshtein("telma", "te1ma")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3); // classic
  });

  it("is symmetric", () => {
    expect(levenshtein("abcd", "abxd")).toBe(levenshtein("abxd", "abcd"));
  });
});

describe("similarity", () => {
  it("returns 1 for identical and for empty/empty", () => {
    expect(similarity("hba1c", "hba1c")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });

  it("scales by the longer length", () => {
    // one edit over length 6 → 1 - 1/6
    expect(similarity("crocin", "croin")).toBeCloseTo(1 - 1 / 6, 5);
    expect(similarity("metformin", "metf0rmin")).toBeCloseTo(1 - 1 / 9, 5);
  });

  it("is 0 for fully dissimilar same-length strings", () => {
    expect(similarity("abc", "xyz")).toBe(0);
  });
});

describe("rankMatches", () => {
  const items = [
    { name: "alpha", aka: ["a"] },
    { name: "alpine", aka: [] },
    { name: "beta", aka: ["b"] },
  ];
  const aliasesOf = (i: (typeof items)[number]) => [i.name, ...i.aka];

  it("ranks by best alias similarity, highest first", () => {
    const r = rankMatches("alpha", items, aliasesOf);
    expect(r[0].item.name).toBe("alpha");
    expect(r[0].score).toBe(1);
    expect(r[0].via).toBe("alpha");
    expect(r[1].item.name).toBe("alpine"); // closer than beta
  });

  it("honours minScore and limit", () => {
    const r = rankMatches("alpha", items, aliasesOf, { minScore: 0.9, limit: 1 });
    expect(r).toHaveLength(1);
    expect(r[0].item.name).toBe("alpha");
  });

  it("returns an empty array when nothing clears minScore", () => {
    expect(rankMatches("zzzzzz", items, aliasesOf, { minScore: 0.9 })).toEqual([]);
  });
});
