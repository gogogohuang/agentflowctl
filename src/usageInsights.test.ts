import { describe, expect, it } from "vitest";
import { computeUsageInsights } from "./usageInsights.js";
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
    expect(insights.byTask["T-1"]).toMatchObject({ tokens: 77, runs: 2 });
    expect(insights.byTask["非任務步驟"]).toMatchObject({ tokens: 110, runs: 2, unreportedRuns: 1 });
    expect(insights.byAgent.a).toMatchObject({ tokens: 143, runs: 2 });
    expect(insights.byModelStage["CLI 預設（名稱未知） / plan"]).toMatchObject({ tokens: 110, runs: 1 });
    expect(insights.byModelStage["small / T-1-code"]).toMatchObject({ tokens: 77, runs: 2 });
    expect(insights.substitutions).toBe(3);
    expect(insights.runs).toEqual([
      { id: "f-a", tokens: 143, calls: 2 },
      { id: "f-b", tokens: 44, calls: 2 },
    ]);
  });
});
