import { describe, expect, it } from "vitest";
import { computeUsageInsights, FINDING_LABEL, usageFindings } from "./usageInsights.js";
import { totalUsage } from "./store.js";
import type { RetryEntry } from "./store.js";
import type { UsageEntry } from "./store.js";

const usage = (partial: Partial<UsageEntry> & Pick<UsageEntry, "stage">): UsageEntry => ({
  agent: "a", usageReported: true, inputTokens: 0, outputTokens: 0, ...partial,
});

const retry = (partial: Partial<RetryEntry> & Pick<RetryEntry, "category">): RetryEntry => ({
  key: "spec", backTo: "spec", attempt: 1, final: false, ...partial,
});

describe("computeUsageInsights", () => {
  it("沒有 run 時全部為 0", () => {
    const insights = computeUsageInsights([]);
    expect(insights.total).toMatchObject({ tokens: 0, runs: 0, reportedRuns: 0 });
    expect(insights.byStage).toEqual({});
    expect(insights.substitutions).toBe(0);
    expect(insights.findings).toEqual([]);
    expect(insights.runs).toEqual([]);
  });

  it("跨 run 加總強度、階段、任務與代打，並保留各 run 小計", () => {
    const insights = computeUsageInsights([
      {
        id: "f-a",
        substitutions: 1,
        retries: [retry({ category: "format_invalid" })],
        usage: [
          usage({ stage: "plan", strength: "high", inputTokens: 100, outputTokens: 10 }),
          usage({ stage: "T-1-code", strength: "low", model: "small", inputTokens: 30, outputTokens: 3 }),
        ],
      },
      {
        id: "f-b",
        substitutions: 2,
        retries: [],
        usage: [
          usage({ stage: "T-1-code", agent: "b", model: "small", strength: "low", inputTokens: 40, outputTokens: 4 }),
          usage({ stage: "review", agent: "b", usageReported: false }),
        ],
      },
    ]);
    expect(insights.total).toMatchObject({ tokens: 187, inputTokens: 170, outputTokens: 17, runs: 4, reportedRuns: 3, unreportedRuns: 1 });
    expect(insights.byStrength.high).toMatchObject({ tokens: 110, runs: 1 });
    expect(insights.byStrength.low).toMatchObject({ tokens: 77, runs: 2 });
    expect(insights.byStage.taskCode).toMatchObject({ tokens: 77, runs: 2 });
    expect(insights.byStage.plan).toMatchObject({ tokens: 110, runs: 1 });
    expect(insights.byAgent.a).toMatchObject({ tokens: 143, runs: 2 });
    expect(insights.byModelStage["CLI 預設（名稱未知） / plan"]).toMatchObject({ tokens: 110, runs: 1 });
    expect(insights.byModelStage["small / taskCode"]).toMatchObject({ tokens: 77, runs: 2 });
    expect(insights.substitutions).toBe(3);
    expect(insights.runs).toEqual([
      { id: "f-a", tokens: 143, calls: 2, reportedCalls: 2, topTask: { task: "T-1", tokens: 33, share: 1, tasks: 1 } },
      { id: "f-b", tokens: 44, calls: 2, reportedCalls: 1, topTask: { task: "T-1", tokens: 44, share: 1, tasks: 1 } },
    ]);
  });

  it("不同 run 的同名任務不合併；任務步驟依種類合併模型用量", () => {
    const insights = computeUsageInsights([
      { id: "f-a", substitutions: 0, retries: [], usage: [
        usage({ stage: "T-1-code", model: "small", inputTokens: 60 }),
        usage({ stage: "T-2-code", model: "small", inputTokens: 40 }),
      ] },
      { id: "f-b", substitutions: 0, retries: [], usage: [usage({ stage: "T-1-code", model: "small", inputTokens: 10 })] },
    ]);
    expect(insights.byModelStage).toEqual({ "small / taskCode": expect.objectContaining({ tokens: 110, runs: 3 }) });
    expect(insights.runs.map((r) => [r.id, r.topTask?.task, r.topTask?.tokens, r.topTask?.tasks])).toEqual([
      ["f-a", "T-1", 60, 2],
      ["f-b", "T-1", 10, 1],
    ]);
    const hot = insights.findings.find((f) => f.code === "hot_task");
    expect(hot?.detail).toContain("f-a 的 T-1");
    expect(hot?.impactTokens).toBe(60);
  });
});

describe("FINDING_LABEL", () => {
  it("每個建議代碼都有繁中標題", () => {
    expect(FINDING_LABEL.high_strength_share).toBe("高強度模型占比偏高");
    expect(FINDING_LABEL.retry_waste).toBe("重試可能比單次 prompt 更耗 token");
    expect(FINDING_LABEL.hot_model_step).toBe("單一模型與步驟佔用量過高");
    expect(FINDING_LABEL.hot_failing_step).toBe("單一執行步驟失敗次數過多");
  });
});

describe("usageFindings", () => {
  const empty = totalUsage([]);
  const summary = (partial: Partial<typeof empty> & Pick<typeof empty, "tokens" | "runs" | "reportedRuns">) => ({ ...empty, ...partial });

  it("覆蓋不足時固定排第一，其餘依 impact 排序且最多 5 則", () => {
    const findings = usageFindings({
      total: summary({
        tokens: 20000, inputTokens: 19000, outputTokens: 1000, runs: 10, reportedRuns: 6, unreportedRuns: 4,
        cacheWriteTokens: 2000, cacheReadTokens: 100,
      }),
      byStrength: { high: summary({ tokens: 12000, runs: 4, reportedRuns: 4 }) },
      byStage: {
        taskCode: summary({ tokens: 9000, runs: 3, reportedRuns: 3 }),
        review: summary({ tokens: 8000, runs: 2, reportedRuns: 2 }),
        spec: summary({ tokens: 3000, runs: 1, reportedRuns: 1 }),
      },
      topTasks: [{ id: "f-a", topTask: { task: "T-1", tokens: 7000, share: 7000 / 9000, tasks: 2 } }],
      retries: [retry({ category: "format_invalid" }), retry({ category: "format_invalid", attempt: 2 }), retry({ category: "tests_not_red", key: "T-1:tests" })],
      substitutions: 2,
    });
    expect(findings.map((f) => f.code)).toEqual([
      "coverage_low", "input_heavy", "high_strength_share", "retry_waste", "hot_stage",
    ]);
    const retryFinding = findings.find((f) => f.code === "retry_waste");
    expect(retryFinding?.detail).toContain("輸出格式錯誤");
    expect(retryFinding?.detail).toContain("3 次");
  });

  it("審查要求修改與仲裁要求修訂不算進 retry_waste；只有一個任務的 run 不觸發 hot_task", () => {
    const codes = usageFindings({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 2, reportedRuns: 2 }),
      byStrength: {},
      byStage: {},
      retries: [retry({ category: "review_changes" }), retry({ category: "arbitration_revise" }), retry({ category: "format_invalid" })],
      topTasks: [{ id: "f-a", topTask: { task: "T-1", tokens: 100, share: 1, tasks: 1 } }],
      substitutions: 0,
    }).map((f) => f.code);
    expect(codes).not.toContain("retry_waste");
    expect(codes).not.toContain("hot_task");
  });

  it("未達門檻時不產生建議", () => {
    expect(usageFindings({
      total: summary({ tokens: 100, inputTokens: 80, outputTokens: 20, runs: 2, reportedRuns: 2 }),
      byStrength: { low: summary({ tokens: 100, runs: 2, reportedRuns: 2 }) },
      byStage: { spec: summary({ tokens: 100, runs: 2, reportedRuns: 2 }) },
      retries: [retry({ category: "format_invalid" })],
      substitutions: 1,
    })).toEqual([]);
  });

  it("高強度占比、輸入偏重、熱階段與熱任務各自觸發", () => {
    const codes = (input: Parameters<typeof usageFindings>[0]) => usageFindings(input).map((f) => f.code);
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 2, reportedRuns: 2 }),
      byStrength: { high: summary({ tokens: 39, runs: 1, reportedRuns: 1 }), low: summary({ tokens: 61, runs: 1, reportedRuns: 1 }) },
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("high_strength_share");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 2, reportedRuns: 2 }),
      byStrength: { high: summary({ tokens: 40, runs: 1, reportedRuns: 1 }), low: summary({ tokens: 60, runs: 1, reportedRuns: 1 }) },
      byStage: {},
      retries: [],
      substitutions: 0,
    })).toContain("high_strength_share");
    expect(codes({
      total: summary({ tokens: 5000, inputTokens: 4250, outputTokens: 750, runs: 1, reportedRuns: 1 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).toContain("input_heavy");
    // 輸入幾乎全是 cache 讀取：不算輸入太大
    expect(codes({
      total: summary({ tokens: 10000, inputTokens: 9500, outputTokens: 500, cacheReadTokens: 9000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("input_heavy");
    // 比例達門檻，但不含 cache 讀取的量體不足
    expect(codes({
      total: summary({ tokens: 10000, inputTokens: 9850, outputTokens: 150, cacheReadTokens: 9000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("input_heavy");
    // cache 讀取回報得比輸入還多（adapter 語意不一致）：不會算出負的輸入量
    expect(codes({
      total: summary({ tokens: 10000, inputTokens: 500, outputTokens: 9500, cacheReadTokens: 2000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("input_heavy");
    const heavy = usageFindings({
      total: summary({ tokens: 10000, inputTokens: 9500, outputTokens: 500, cacheReadTokens: 2000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    }).find((f) => f.code === "input_heavy");
    expect(heavy?.impactTokens).toBe(7500);
    expect(heavy?.detail).toContain("不含 cache 讀取的輸入 7500");
    expect(heavy?.detail).toContain("另有 cache 讀取 2000 未計入");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {
        taskCode: summary({ tokens: 35, runs: 1, reportedRuns: 1 }),
        plan: summary({ tokens: 65, runs: 2, reportedRuns: 2 }),
      },
      retries: [],
      substitutions: 0,
    })).toContain("hot_stage");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {},
      topTasks: [{ id: "f-a", topTask: { task: "T-2", tokens: 50, share: 50 / 90, tasks: 2 } }],
      retries: [],
      substitutions: 0,
    })).toContain("hot_task");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 2, reportedRuns: 2 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      byModelStage: {
        "large / review": summary({ tokens: 34, runs: 1, reportedRuns: 1 }),
        "small / spec": summary({ tokens: 33, runs: 1, reportedRuns: 1 }),
      },
    })).not.toContain("hot_model_step");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 2, reportedRuns: 2 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      byModelStage: {
        "large / review": summary({ tokens: 35, runs: 1, reportedRuns: 1 }),
        "small / spec": summary({ tokens: 33, runs: 1, reportedRuns: 1 }),
      },
    })).toContain("hot_model_step");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      steps: [{ step: "T-1-code", kind: "agent", runs: 4, failed: 2, unfinished: 0, totalMs: 0, maxMs: 0 }],
    })).not.toContain("hot_failing_step");
    expect(codes({
      total: summary({ tokens: 100, inputTokens: 50, outputTokens: 50, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      steps: [{ step: "T-1-code", kind: "agent", runs: 5, failed: 3, unfinished: 0, totalMs: 0, maxMs: 0 }],
    })).toContain("hot_failing_step");
    const cmdOnly = usageFindings({
      total: summary({ tokens: 90, inputTokens: 45, outputTokens: 45, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      steps: [{ step: "lint", kind: "cmd", runs: 5, failed: 3, unfinished: 0, totalMs: 0, maxMs: 0 }],
    }).find((f) => f.code === "hot_failing_step");
    expect(cmdOnly?.impactTokens).toBe(0);
    expect(cmdOnly?.detail).toContain("專案指令");
    const preferAgent = usageFindings({
      total: summary({ tokens: 90, inputTokens: 45, outputTokens: 45, runs: 3, reportedRuns: 3 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
      steps: [
        { step: "lint", kind: "cmd", runs: 10, failed: 8, unfinished: 0, totalMs: 0, maxMs: 0 },
        { step: "T-1-code", kind: "agent", runs: 5, failed: 3, unfinished: 0, totalMs: 0, maxMs: 0 },
      ],
    }).find((f) => f.code === "hot_failing_step");
    expect(preferAgent?.detail).toContain("T-1-code");
    expect(preferAgent?.impactTokens).toBe(90);
  });
});
