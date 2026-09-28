import { describe, expect, it } from "vitest";
import { computeInsights, failureLabel, gateOf, RETRY_LABEL, retryLabel } from "./insights.js";
import type { RetryEntry } from "./store.js";

const retry = (partial: Partial<RetryEntry> & Pick<RetryEntry, "category">): RetryEntry => ({
  key: "spec", backTo: "spec", attempt: 1, final: false, ...partial,
});

describe("computeInsights", () => {
  it("沒有 run 時全部為 0", () => {
    expect(computeInsights([])).toEqual({
      runCount: 0,
      byOutcome: { done: 0, failed: 0, paused: 0, awaiting_approval: 0, active: 0 },
      byFailure: [],
      byCategory: [],
      byGate: [],
      runs: [],
    });
  });

  it("依結果、原因、關卡加總，原因按次數排序", () => {
    const insights = computeInsights([
      { id: "f-a", stage: "done", retries: [retry({ category: "format_invalid", key: "plan" }), retry({ category: "format_invalid", key: "plan", attempt: 2 })] },
      { id: "f-b", stage: "failed", failureCategory: "retry_limit", retries: [retry({ category: "review_changes", key: "review", final: true })] },
      { id: "f-c", stage: "implement", retries: [] },
    ]);
    expect(insights.runCount).toBe(3);
    expect(insights.byOutcome).toEqual({ done: 1, failed: 1, paused: 0, awaiting_approval: 0, active: 1 });
    expect(insights.byCategory).toEqual([
      { category: "format_invalid", count: 2, finals: 0 },
      { category: "review_changes", count: 1, finals: 1 },
    ]);
    expect(insights.byFailure).toEqual([{ category: "retry_limit", count: 1 }]);
    expect(insights.byGate).toEqual([
      { gate: "plan", count: 2 },
      { gate: "review", count: 1 },
    ]);
    expect(insights.runs.map((r) => [r.id, r.retries, r.topCategory])).toEqual([
      ["f-a", 2, "format_invalid"],
      ["f-b", 1, "review_changes"],
      ["f-c", 0, undefined],
    ]);
  });

  it("任務關卡不分 task id 合併，舊 run 的失敗歸為未分類", () => {
    const insights = computeInsights([
      { id: "f-a", stage: "failed", retries: [retry({ category: "tests_not_red", key: "T1:tests" }), retry({ category: "review_changes", key: "T2:review" })] },
      { id: "f-b", stage: "failed", failureCategory: "agent_budget", retries: [retry({ category: "tests_not_red", key: "T3:tests" })] },
    ]);
    expect(insights.byGate).toEqual([
      { gate: "任務:tests", count: 2 },
      { gate: "任務:review", count: 1 },
    ]);
    expect(insights.byFailure).toEqual(expect.arrayContaining([{ category: "unknown", count: 1 }, { category: "agent_budget", count: 1 }]));
  });

  it("gateOf 只合併任務關卡", () => {
    expect(gateOf("T-1:review-run")).toBe("任務:review-run");
    expect(gateOf("plan-review-run")).toBe("plan-review-run");
    expect(gateOf("plan-arbitration")).toBe("plan-arbitration");
  });
});

describe("標籤", () => {
  it("不認得的分類直接顯示代碼", () => {
    expect(retryLabel("future_category")).toBe("future_category");
    expect(failureLabel(undefined)).toBe("未分類（舊 run）");
    expect(failureLabel("future_failure")).toBe("future_failure");
  });
});

describe("RETRY_LABEL", () => {
  it("每個分類都有繁中標籤", () => {
    expect(RETRY_LABEL.format_invalid).toBe("輸出格式錯誤");
    expect(RETRY_LABEL.tests_not_red).toBe("紅燈測試未失敗");
  });
});
