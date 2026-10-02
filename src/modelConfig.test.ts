import { describe, expect, it } from "vitest";
import { addModel, removeModel, setModelMode, setModelStrength, setStageStrength } from "./modelConfig.js";

const base = () => ({ agents: {
  a: { adapter: "claude", models: [{ name: "small", strength: "low" }] },
  b: { adapter: "gemini", models: [{ name: "large", strength: "high" }] },
}, cycle: ["a", "b"] });

describe("模型設定編輯", () => {
  it("新增模型保留順序並拒絕重複的名稱與強度", () => {
    const cfg = addModel(base(), "a", "middle", "medium");
    expect(((cfg.agents as Record<string, { models: unknown[] }>).a?.models)).toEqual([
      { name: "small", strength: "low" }, { name: "middle", strength: "medium" },
    ]);
    expect(() => addModel(cfg, "a", "middle", "medium")).toThrow(/重複/);
    expect(() => addModel(cfg, "a", " middle ", "high")).toThrow(/空白/);
  });

  it("同名模型可用不同強度並存；同名同強度重複，set／remove 多筆時要用 at 指定", () => {
    let cfg = addModel(base(), "a", "small", "high", "high");
    const models = () => (cfg.agents as Record<string, { models: Array<{ name: string; strength: string; effort?: string }> }>).a!.models;
    expect(models()).toEqual([{ name: "small", strength: "low" }, { name: "small", strength: "high", effort: "high" }]);
    expect(() => addModel(cfg, "a", "small", "high")).toThrow(/重複/);
    expect(() => setModelStrength(cfg, "a", "small", undefined, "low")).toThrow(/--at/);
    expect(() => removeModel(cfg, "a", "small")).toThrow(/--at/);
    expect(() => setModelStrength(cfg, "a", "small", undefined, "low", "medium")).toThrow(/沒有強度 medium/);
    cfg = setModelStrength(cfg, "a", "small", undefined, "xhigh", "high");
    expect(models()[1]).toEqual({ name: "small", strength: "high", effort: "xhigh" });
    cfg = removeModel(cfg, "a", "small", "high");
    expect(models()).toEqual([{ name: "small", strength: "low" }]);
  });

  it("新增與修改 effort；null 清除，沒給任何欄位則拒絕", () => {
    const cfg = addModel(base(), "a", "middle", "medium", "high");
    const models = () => (cfg2.agents as Record<string, { models: Array<{ name: string; strength: string; effort?: string }> }>).a!.models;
    expect(((cfg.agents as Record<string, { models: unknown[] }>).a?.models)[1]).toEqual({ name: "middle", strength: "medium", effort: "high" });
    let cfg2 = setModelStrength(cfg, "a", "middle", undefined, "low");
    expect(models()[1]).toEqual({ name: "middle", strength: "medium", effort: "low" });
    cfg2 = setModelStrength(cfg2, "a", "middle", "high");
    expect(models()[1]).toEqual({ name: "middle", strength: "high", effort: "low" });
    cfg2 = setModelStrength(cfg2, "a", "middle", undefined, null);
    expect(models()[1]).toEqual({ name: "middle", strength: "high" });
    expect(() => setModelStrength(cfg, "a", "middle")).toThrow(/沒有要修改/);
    expect(() => addModel(base(), "b", "x", "low", "high")).toThrow(/不支援 effort/);
  });

  it("修改強度不改名稱，移除最後一個參與模型時拒絕", () => {
    const cfg = setModelStrength(base(), "a", "small", "medium");
    expect(((cfg.agents as Record<string, { models: Array<{ strength: string }> }>).a?.models[0]?.strength)).toBe("medium");
    expect(() => removeModel(setModelMode(cfg, "adaptive"), "a", "small")).toThrow(/缺少模型：a/);
  });

  it("balanced 模式也拒絕移除參與者的最後一個模型", () => {
    expect(() => removeModel(base(), "a", "small")).toThrow(/缺少模型：a/);
  });

  it("adaptive 下移除最後一個模型時，列出受影響範圍內所有缺模型的 agent", () => {
    const cfg = { agents: { a: { adapter: "claude", models: [{ name: "small", strength: "low" }] }, b: { adapter: "gemini" } }, modelSelection: { mode: "adaptive" } };
    expect(() => removeModel(cfg, "a", "small")).toThrow("以下 agent 缺少模型：a、b");
    const onlyB = { ...cfg, cycle: ["b"], agents: { ...cfg.agents, b: { adapter: "gemini", models: [{ name: "large", strength: "high" }] } } };
    expect(removeModel(onlyB, "a", "small").agents).toMatchObject({ a: { models: [] } });
  });

  it("啟用 adaptive 檢查 cycle；階段強度只接受已定義的鍵", () => {
    expect(setModelMode(base(), "adaptive").modelSelection).toMatchObject({ mode: "adaptive" });
    expect(() => setModelMode({ agents: { a: { adapter: "claude" } } }, "adaptive")).toThrow(/a/);
    expect(setStageStrength(base(), "taskReview", "high").modelSelection).toMatchObject({ stageStrength: { taskReview: "high" } });
    expect(() => setStageStrength(base(), "unknown" as "taskReview", "low")).toThrow(/unknown/);
  });
});
