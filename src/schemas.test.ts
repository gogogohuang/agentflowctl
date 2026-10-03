import { describe, expect, it } from "vitest";
import { AmendRequest, ConsistentReviewResult, DivergePick, DivergeRecord, FlowRun, RepoConfig, TaskItem } from "./schemas.js";

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

describe("FlowRun.stopAfter", () => {
  const base = { id: "f-stop", baseBranch: "main", branch: "flow/f-stop", requirement: "x", stage: "spec", autopilot: true, maxAgentRuns: 60, cycle: ["claude"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: "t", updatedAt: "t" };

  it("接受公開停點，且舊 state.json 省略時仍可讀取", () => {
    expect(FlowRun.safeParse({ ...base, stopAfter: "verify" }).success).toBe(true);
    expect(FlowRun.safeParse(base).success).toBe(true);
  });

  it("拒絕內部階段與未知停點", () => {
    expect(FlowRun.safeParse({ ...base, stopAfter: "plan_review" }).success).toBe(false);
    expect(FlowRun.safeParse({ ...base, stopAfter: "later" }).success).toBe(false);
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

describe("審查平行設定", () => {
  it("沒寫時為 undefined（不限）", () => {
    expect(RepoConfig.parse({}).reviewConcurrency).toBeUndefined();
  });

  it("接受正整數", () => {
    expect(RepoConfig.parse({ reviewConcurrency: 1 }).reviewConcurrency).toBe(1);
    expect(RepoConfig.parse({ reviewConcurrency: 4 }).reviewConcurrency).toBe(4);
  });

  it("拒絕 0、負數與小數", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(RepoConfig.safeParse({ reviewConcurrency: bad }).success).toBe(false);
    }
  });
});

describe("RepoConfig.diverge", () => {
  const defaults = { enabled: true, after: 2, branches: 3 };

  it("沒寫時用預設，只寫一個子欄位時其餘補上預設", () => {
    expect(RepoConfig.parse({}).diverge).toEqual(defaults);
    expect(RepoConfig.parse({ diverge: { enabled: false } }).diverge).toEqual({ ...defaults, enabled: false });
  });

  it("after 小於 1、branches 不是 2 或 3、或寫了未知子欄位時拒絕", () => {
    expect(RepoConfig.safeParse({ diverge: { after: 0 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { branches: 1 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { branches: 4 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { frames: 3 } }).success).toBe(false);
  });
});

describe("DivergePick", () => {
  it("pick 與 action 必須是允許的值", () => {
    expect(DivergePick.safeParse({
      pick: "acceptance", action: "keep_fixing", rationale: "對上驗收", nextStep: "改斷言",
    }).success).toBe(true);
    expect(DivergePick.safeParse({
      pick: "other", action: "keep_fixing", rationale: "x", nextStep: "y",
    }).success).toBe(false);
  });
});

describe("DivergeRecord", () => {
  it("retriesSeen 是非負整數，可省略", () => {
    const base = { stamp: "T-1:code:2:0", status: "done", key: "T-1:code", frames: ["acceptance"] };
    expect(DivergeRecord.safeParse({ ...base, retriesSeen: 2 }).success).toBe(true);
    expect(DivergeRecord.safeParse(base).success).toBe(true);
    expect(DivergeRecord.safeParse({ ...base, retriesSeen: -1 }).success).toBe(false);
  });
});

describe("修補請求", () => {
  it("AmendRequest 補上 files 預設值，並要求至少一條驗收條件", () => {
    const ok = AmendRequest.safeParse({ target: "T-1", reason: "回傳值要改成物件", acceptance: ["answer 為物件"] });
    expect(ok.success && ok.data.files).toEqual([]);
    expect(AmendRequest.safeParse({ target: "T-1", reason: "x", acceptance: [] }).success).toBe(false);
    expect(AmendRequest.safeParse({ target: "task1", reason: "x", acceptance: ["a"] }).success).toBe(false);
    expect(AmendRequest.safeParse({ target: "T-1", reason: "  ", acceptance: ["a"] }).success).toBe(false);
  });

  it("TaskItem 接受 amend 種類與 amendOf", () => {
    const task = TaskItem.parse({ id: "T-4", title: "修補", description: "d", acceptance: ["AC-3"], kind: "amend", amendOf: "T-1" });
    expect(task.kind).toBe("amend");
    expect(task.amendOf).toBe("T-1");
  });

  it("RepoConfig 的 maxAmendments 預設 2", () => {
    expect(RepoConfig.parse({}).maxAmendments).toBe(2);
    expect(RepoConfig.safeParse({ maxAmendments: 0 }).success).toBe(false);
  });
});
