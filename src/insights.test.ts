import { describe, expect, it } from "vitest";
import { computeInsights, RETRY_LABEL } from "./insights.js";
import type { RetryEntry } from "./store.js";

const retry = (partial: Partial<RetryEntry> & Pick<RetryEntry, "category">): RetryEntry => ({
  key: "spec", stage: "spec", attempt: 1, final: false, ...partial,
});

describe("computeInsights", () => {
  it("沒有 run 時全部為 0", () => {
    expect(computeInsights([])).toEqual({
      runCount: 0,
      byOutcome: { done: 0, failed: 0, paused: 0, awaiting_approval: 0, active: 0 },
      byCategory: [],
      byKey: [],
      runs: [],
    });
  });

  it("依結果、原因、關卡加總，原因按次數排序", () => {
    const insights = computeInsights([
      { id: "f-a", stage: "done", retries: [retry({ category: "format_invalid", key: "plan" }), retry({ category: "format_invalid", key: "plan", attempt: 2 })] },
      { id: "f-b", stage: "failed", retries: [retry({ category: "review_changes", key: "review", final: true })] },
      { id: "f-c", stage: "implement", retries: [] },
    ]);
    expect(insights.runCount).toBe(3);
    expect(insights.byOutcome).toEqual({ done: 1, failed: 1, paused: 0, awaiting_approval: 0, active: 1 });
    expect(insights.byCategory).toEqual([
      { category: "format_invalid", count: 2, finals: 0 },
      { category: "review_changes", count: 1, finals: 1 },
    ]);
    expect(insights.byKey).toEqual([
      { key: "plan", count: 2 },
      { key: "review", count: 1 },
    ]);
    expect(insights.runs.map((r) => [r.id, r.retries, r.topCategory])).toEqual([
      ["f-a", 2, "format_invalid"],
      ["f-b", 1, "review_changes"],
      ["f-c", 0, undefined],
    ]);
  });
});

describe("RETRY_LABEL", () => {
  it("每個分類都有繁中標籤", () => {
    expect(RETRY_LABEL.format_invalid).toBe("輸出格式錯誤");
    expect(RETRY_LABEL.tests_not_red).toBe("紅燈測試未失敗");
  });
});
