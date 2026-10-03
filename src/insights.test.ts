import { describe, expect, it } from "vitest";
import { computeInsights, failureLabel, gateOf, RETRY_LABEL, RETRY_RULES, retryLabel } from "./insights.js";
import { RetryCategories } from "./store.js";
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
      hotspots: [],
      flaky: [],
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

describe("反覆出現的失敗與對應規則", () => {
  const run = (id: string, categories: RetryEntry["category"][]) => ({ id, stage: "done", retries: categories.map((category) => retry({ category })) });

  it("同一類至少 3 次且分散在 2 個以上的 run 才算反覆出現，附上對應規則，依次數排序", () => {
    const insights = computeInsights([
      run("f-a", ["tests_not_red", "tests_not_red", "out_of_scope"]),
      run("f-b", ["tests_not_red", "out_of_scope", "out_of_scope"]),
      run("f-c", ["format_invalid", "format_invalid", "format_invalid"]), // 次數夠但只在一個 run
    ]);
    expect(insights.hotspots.map((h) => [h.category, h.count, h.runs])).toEqual([["tests_not_red", 3, 2], ["out_of_scope", 3, 2]]);
    expect(insights.hotspots[0]).toMatchObject({ rules: RETRY_RULES.tests_not_red.rules, hint: RETRY_RULES.tests_not_red.hint });
  });

  it("次數不足時沒有熱點", () => {
    expect(computeInsights([run("f-a", ["tests_not_red"]), run("f-b", ["tests_not_red"])]).hotspots).toEqual([]);
  });

  it("每個重試類別都有對應的規則與說明", () => {
    for (const category of RetryCategories) {
      expect(RETRY_RULES[category].rules.length, category).toBeGreaterThan(0);
      expect(RETRY_RULES[category].hint, category).not.toBe("");
    }
  });

  it("不穩定的檢查依名稱加總", () => {
    const insights = computeInsights([
      { id: "f-a", stage: "done", retries: [], flaky: [{ check: "test" }, { check: "lint" }] },
      { id: "f-b", stage: "done", retries: [], flaky: [{ check: "test" }] },
      { id: "f-c", stage: "done", retries: [] },
    ]);
    expect(insights.flaky).toEqual([{ check: "test", count: 2 }, { check: "lint", count: 1 }]);
  });
});
