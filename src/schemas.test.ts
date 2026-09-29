import { describe, expect, it } from "vitest";
import { ConsistentReviewResult, FlowRun, RepoConfig } from "./schemas.js";

describe("審查結果的 verdict 與 items 一致性", () => {
  const unmet = { criterion: "AC-1", status: "not_met", note: "src/form.tsx 缺少錯誤訊息" };

  it("verdict 與 items 一致時通過", () => {
    expect(ConsistentReviewResult.safeParse({ verdict: "approve", items: [] }).success).toBe(true);
    expect(ConsistentReviewResult.safeParse({ verdict: "approve", items: [{ criterion: "AC-1", status: "met" }] }).success).toBe(true);
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [unmet] }).success).toBe(true);
  });

  it("approve 卻有未通過項目時拒絕", () => {
    const r = ConsistentReviewResult.safeParse({ verdict: "approve", items: [unmet] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/AC-1/);
  });

  it("changes_requested 卻沒有未通過項目時拒絕", () => {
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [] }).success).toBe(false);
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [{ criterion: "AC-1", status: "met" }] }).success).toBe(false);
  });
});

describe("計畫分層審查設定", () => {
  const defaults = { enabled: true, minTasks: 7, maxGroups: 5, tasksPerGroup: 3 };

  it("沒寫時用預設，只寫一個子欄位時其餘補上預設", () => {
    expect(RepoConfig.parse({}).planReviewLayers).toEqual(defaults);
    expect(RepoConfig.parse({ planReviewLayers: { enabled: false } }).planReviewLayers).toEqual({ ...defaults, enabled: false });
  });

  it("群數上限小於 2 或寫了未知子欄位時拒絕", () => {
    expect(RepoConfig.safeParse({ planReviewLayers: { maxGroups: 1 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ planReviewLayers: { groups: 3 } }).success).toBe(false);
  });
});

describe("FlowRun.maxAttempts", () => {
  it("舊 state.json 沒有這個欄位也讀得進來", () => {
    const base = { id: "f-a", baseBranch: "main", branch: "flow/f-a", requirement: "x", stage: "spec", autopilot: true, maxAgentRuns: 60, cycle: ["claude"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: "t", updatedAt: "t" };
    expect(FlowRun.safeParse(base).success).toBe(true);
    expect(FlowRun.safeParse({ ...base, maxAttempts: 8 }).success).toBe(true);
    expect(FlowRun.safeParse({ ...base, maxAttempts: 2 }).success).toBe(false);
  });
});

describe("RepoConfig 的 maxAttempts 與 verbose", () => {
  it("預設 5 次、不顯示詳細輸出；可在設定檔覆蓋", () => {
    expect(RepoConfig.parse({})).toMatchObject({ maxAttempts: 5, verbose: false });
    expect(RepoConfig.parse({ maxAttempts: 10, verbose: true })).toMatchObject({ maxAttempts: 10, verbose: true });
  });

  it("maxAttempts 低於 3 直接報錯", () => {
    expect(() => RepoConfig.parse({ maxAttempts: 2 })).toThrow();
  });
});

