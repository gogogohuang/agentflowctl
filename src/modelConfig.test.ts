import { describe, expect, it } from "vitest";
import { addModel, removeModel, setModelMode, setModelStrength, setStageStrength } from "./modelConfig.js";

const base = () => ({ agents: {
  a: { adapter: "claude", models: [{ name: "small", strength: "low" }] },
  b: { adapter: "gemini", models: [{ name: "large", strength: "high" }] },
}, cycle: ["a", "b"] });

describe("模型設定編輯", () => {
  it("新增模型保留順序並拒絕重複名稱", () => {
    const cfg = addModel(base(), "a", "middle", "medium");
    expect(((cfg.agents as Record<string, { models: unknown[] }>).a?.models)).toEqual([
      { name: "small", strength: "low" }, { name: "middle", strength: "medium" },
    ]);
    expect(() => addModel(cfg, "a", "middle", "high")).toThrow(/重複/);
    expect(() => addModel(cfg, "a", " middle ", "high")).toThrow(/空白/);
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
