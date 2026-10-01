import { describe, expect, it } from "vitest";
import { clearModelReviewFailure, clearModelReviewStage, effectiveStageStrengths, recordModelReviewFailure, selectModel, stageOfStep, validateAdaptiveConfig } from "./modelSelection.js";
import { FlowRun, RepoConfig } from "./schemas.js";

const run = (overrides: Record<string, unknown> = {}) => FlowRun.parse({
  id: "f-test", baseBranch: "main", branch: "flow/f-test", requirement: "測試", stage: "implement",
  autopilot: true, maxAgentRuns: 60, cycle: ["a"], attempts: {}, taskIndex: 0,
  taskPhase: "tests", createdAt: "2026-01-01", updatedAt: "2026-01-01",
  modelMode: "adaptive", ...overrides,
});

const cfg = () => RepoConfig.parse({ agents: { a: { adapter: "codex", models: [
  { name: "small", strength: "low" },
  { name: "middle", strength: "medium" },
  { name: "large", strength: "high" },
] } } });

describe("階段強度", () => {
  it("列出每個階段實際生效的強度與來源", () => {
    const custom = RepoConfig.parse({ agents: {}, modelSelection: { stageStrength: { taskReview: "high" } } });
    const all = effectiveStageStrengths(custom);
    expect(all.taskReview).toEqual({ strength: "high", custom: true });
    expect(all.plan).toEqual({ strength: "high", custom: false });
    expect(all.taskCode).toEqual({ strength: "low", custom: false });
    expect(Object.keys(all)).toHaveLength(11);
  });
});

describe("依階段與任務難度選模", () => {
  it("低難度任務選最低足夠強度，高難度任務提高底線", () => {
    expect(selectModel(run(), cfg(), "a", "T-1-code", "low").name).toBe("small");
    expect(selectModel(run(), cfg(), "a", "T-1-code", "high").name).toBe("large");
  });

  it("任務執行失敗後升級，但不超過 high", () => {
    expect(selectModel(run({ attempts: { "T-1:code": 1 } }), cfg(), "a", "T-1-code", "low").name).toBe("middle");
    expect(selectModel(run({ attempts: { "T-1:code": 3 } }), cfg(), "a", "T-1-code", "low").name).toBe("large");
  });

  it("審查小組只依各審查者的失敗次數升級", () => {
    const current = run({ modelRetryAttempts: { "review:b": 1 }, stage: "review" });
    const config = RepoConfig.parse({ agents: { ...cfg().agents, b: cfg().agents.a } });
    expect(selectModel(current, config, "a", "review", undefined, "a").name).toBe("large");
    expect(selectModel(current, config, "b", "review", undefined, "b").name).toBe("large");
    const lowReview = RepoConfig.parse({ agents: config.agents, modelSelection: { stageStrength: { review: "low" } } });
    expect(selectModel(current, lowReview, "a", "review", undefined, "a").name).toBe("small");
    expect(selectModel(current, lowReview, "b", "review", undefined, "b").name).toBe("middle");
  });

  it("一位審查者失敗不會提高其他人的計數，成功後清掉自己的計數", () => {
    const failed = recordModelReviewFailure(run(), "review", "b");
    expect(failed.modelRetryAttempts).toEqual({ "review:b": 1 });
    expect(clearModelReviewFailure(failed, "review", "a").modelRetryAttempts).toEqual({ "review:b": 1 });
    expect(clearModelReviewFailure(failed, "review", "b").modelRetryAttempts).toEqual({});
  });

  it("沒有足夠強度時選最強模型並標示不足", () => {
    const config = RepoConfig.parse({ agents: { a: { adapter: "codex", models: [{ name: "small", strength: "low" }] } } });
    expect(selectModel(run(), config, "a", "plan")).toMatchObject({ name: "small", targetStrength: "high", insufficient: true });
  });

  it("balanced 沿用單一模型與預設模型", () => {
    const config = RepoConfig.parse({ agents: { a: { adapter: "codex" } }, defaultModels: { codex: "default" } });
    expect(selectModel(run({ modelMode: "balanced" }), config, "a", "plan").name).toBe("default");
    expect(selectModel(run({ modelMode: "balanced" }), RepoConfig.parse({ agents: { a: { adapter: "codex", model: "custom" } } }), "a", "plan").name).toBe("custom");
  });

  it("任務群審查沿用計畫審查強度，整輪結束時清掉群與索引的失敗次數", () => {
    expect(stageOfStep("plan-review-group")).toBe("planReview");
    const failed = recordModelReviewFailure(
      recordModelReviewFailure(run(), "plan-review", "b"),
      "plan-review-group",
      "c",
    );
    expect(failed.modelRetryAttempts).toEqual({ "plan-review:b": 1, "plan-review-group:c": 1 });
    expect(clearModelReviewStage(failed, "plan-review").modelRetryAttempts).toEqual({});
    const low = RepoConfig.parse({ agents: cfg().agents, modelSelection: { stageStrength: { planReview: "low" } } });
    expect(selectModel(run(), low, "a", "plan-review-group", undefined, "a").name).toBe("small");
  });

  it("任務群審查的失敗計數帶群 id，一群失敗不會讓其他群升級", () => {
    const failed = recordModelReviewFailure(run(), "plan-review-group", "a", "G-1");
    expect(failed.modelRetryAttempts).toEqual({ "plan-review-group:G-1:a": 1 });
    const low = RepoConfig.parse({ agents: cfg().agents, modelSelection: { stageStrength: { planReview: "low" } } });
    expect(selectModel(failed, low, "a", "plan-review-group", undefined, "a", "G-1").name).toBe("middle");
    expect(selectModel(failed, low, "a", "plan-review-group", undefined, "a", "G-2").name).toBe("small");
    expect(clearModelReviewFailure(failed, "plan-review-group", "a", "G-2").modelRetryAttempts).toEqual({ "plan-review-group:G-1:a": 1 });
    expect(clearModelReviewFailure(failed, "plan-review-group", "a", "G-1").modelRetryAttempts).toEqual({});
    expect(clearModelReviewStage(recordModelReviewFailure(failed, "plan-review", "b"), "plan-review").modelRetryAttempts).toEqual({});
  });
});

describe("adaptive 設定檢查", () => {
  it("拒絕沒有模型清單或與 extraArgs 衝突的 agent", () => {
    expect(() => validateAdaptiveConfig(RepoConfig.parse({ agents: { a: { adapter: "codex" } } }), ["a"])).toThrow(/a.*models/);
    expect(() => validateAdaptiveConfig(RepoConfig.parse({ agents: { a: { adapter: "codex" }, b: { adapter: "claude" } } }), ["a", "b"]))
      .toThrow(/a、b[\s\S]*model add a[\s\S]*model add b[\s\S]*model mode balanced/);
    expect(() => validateAdaptiveConfig(RepoConfig.parse({ agents: { a: { adapter: "codex", models: [{ name: "x", strength: "low" }], extraArgs: ["-m", "other"] } } }), ["a"])).toThrow(/extraArgs/);
  });
});

describe("effort", () => {
  const withEffort = () => RepoConfig.parse({ agents: { a: { adapter: "claude", effort: "medium", models: [
    { name: "small", strength: "low", effort: "low" },
    { name: "large", strength: "high" },
  ] } } });

  it("adaptive 取被選中模型的 effort，沒寫時退回 agent 的 effort", () => {
    expect(selectModel(run(), withEffort(), "a", "T-1-code", "low")).toMatchObject({ name: "small", effort: "low" });
    expect(selectModel(run(), withEffort(), "a", "T-1-code", "high")).toMatchObject({ name: "large", effort: "medium" });
  });

  it("balanced 沿用 agent 的 effort", () => {
    expect(selectModel(run({ modelMode: "balanced" }), withEffort(), "a", "T-1-code")).toMatchObject({ effort: "medium" });
  });

  it("gemini 與 command 不能設定 effort，extraArgs 的 --effort 與 adaptive 衝突", () => {
    expect(() => RepoConfig.parse({ agents: { g: { adapter: "gemini", effort: "high" } } })).toThrow(/不支援 effort/);
    expect(() => RepoConfig.parse({ agents: { c: { adapter: "command", command: ["x"], models: [{ name: "m", strength: "low", effort: "low" }] } } })).toThrow(/不支援 effort/);
    const conflict = RepoConfig.parse({ agents: { a: { adapter: "claude", extraArgs: ["--effort", "high"], models: [{ name: "m", strength: "low" }] } } });
    expect(() => validateAdaptiveConfig(conflict, ["a"])).toThrow(/衝突/);
  });
});
