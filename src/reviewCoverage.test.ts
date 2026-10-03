import { describe, expect, it } from "vitest";
import { checkReviewCoverage, isAcceptanceItem, splitUnmet } from "./reviewCoverage.js";
import type { ReviewResult } from "./schemas.js";

const item = (criterion: string, status: "met" | "not_met" | "partial", evidence = "", note = "") => ({ criterion, status, note, evidence });
const review = (verdict: ReviewResult["verdict"], items: ReviewResult["items"]): ReviewResult => ({ verdict, items });
const known = new Set(["AC-1", "AC-2", "AC-3"]);

describe("checkReviewCoverage", () => {
  it("每條該審的驗收條件都有回報就合格", () => {
    expect(checkReviewCoverage(review("approve", [item("AC-1", "met"), item("AC-2", "met")]), ["AC-1", "AC-2"], known)).toBeUndefined();
  });

  it("漏掉的驗收條件要列出來", () => {
    const error = checkReviewCoverage(review("approve", [item("AC-1", "met")]), ["AC-1", "AC-2"], known);
    expect(error).toContain("沒有逐條回報驗收條件：AC-2");
  });

  it("空的 items 一樣算沒有回報", () => {
    expect(checkReviewCoverage(review("approve", []), ["AC-1"], known)).toContain("AC-1");
  });

  it("憑空捏造的驗收條件編號不合格，範圍外但真實存在的編號放行", () => {
    expect(checkReviewCoverage(review("approve", [item("AC-1", "met"), item("AC-9", "met")]), ["AC-1"], known)).toContain("不存在的驗收條件：AC-9");
    expect(checkReviewCoverage(review("approve", [item("AC-1", "met"), item("AC-3", "met")]), ["AC-1"], known)).toBeUndefined();
  });

  it("額外發現沒有 evidence 不合格，有就放行；met 的額外項目不要求", () => {
    const base = [item("AC-1", "met")];
    expect(checkReviewCoverage(review("changes_requested", [...base, item("空陣列", "not_met", "")]), ["AC-1"], known)).toContain("evidence");
    expect(checkReviewCoverage(review("changes_requested", [...base, item("空陣列", "not_met", "a.ts:1")]), ["AC-1"], known)).toBeUndefined();
    expect(checkReviewCoverage(review("approve", [...base, item("備註", "met", "")]), ["AC-1"], known)).toBeUndefined();
  });

  it("criterion 前後的空白不影響比對", () => {
    expect(checkReviewCoverage(review("approve", [item(" AC-1 ", "met")]), ["AC-1"], known)).toBeUndefined();
  });
});

describe("splitUnmet", () => {
  it("沒通過的項目依驗收條件與額外發現分開，met 不算", () => {
    const items = [item("AC-1", "met"), item("AC-2", "partial"), item("空陣列", "not_met", "a.ts:1")];
    const { acceptance, extra } = splitUnmet(items);
    expect(acceptance.map((i) => i.criterion)).toEqual(["AC-2"]);
    expect(extra.map((i) => i.criterion)).toEqual(["空陣列"]);
    expect(isAcceptanceItem(item("AC-12", "met"))).toBe(true);
    expect(isAcceptanceItem(item("AC-12 的邊界", "met"))).toBe(false);
  });
});
