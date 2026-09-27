import { z } from "zod";
import { ModelStage, ModelStrength, RepoConfig, type ModelStrength as Strength } from "./schemas.js";
import type { RawConfig } from "./agentConfig.js";

type RawAgent = Record<string, unknown>;
const agentsOf = (cfg: RawConfig): Record<string, RawAgent> => ({ ...((cfg.agents ?? {}) as Record<string, RawAgent>) });
const modelsOf = (agent: RawAgent): Array<{ name: string; strength: Strength }> => [...((agent.models ?? []) as Array<{ name: string; strength: Strength }>)];

function withAgent(cfg: RawConfig, agent: string, edit: (def: RawAgent) => RawAgent): RawConfig {
  const agents = agentsOf(cfg);
  if (!agents[agent]) throw new Error(`未定義的 agent：${agent}`);
  agents[agent] = edit({ ...agents[agent] });
  const next = { ...cfg, agents };
  RepoConfig.parse(next);
  return next;
}

export function addModel(cfg: RawConfig, agent: string, name: string, strength: Strength): RawConfig {
  ModelStrength.parse(strength);
  if (!name.trim()) throw new Error("模型名稱不可為空");
  if (name !== name.trim()) throw new Error("模型名稱前後不可有空白");
  return withAgent(cfg, agent, (def) => {
    const models = modelsOf(def);
    if (models.some((m) => m.name === name)) throw new Error(`agent ${agent} 的模型名稱 ${name} 重複`);
    return { ...def, models: [...models, { name, strength }] };
  });
}

export function setModelStrength(cfg: RawConfig, agent: string, name: string, strength: Strength): RawConfig {
  ModelStrength.parse(strength);
  return withAgent(cfg, agent, (def) => {
    const models = modelsOf(def);
    if (!models.some((m) => m.name === name)) throw new Error(`agent ${agent} 沒有模型 ${name}`);
    return { ...def, models: models.map((m) => m.name === name ? { ...m, strength } : m) };
  });
}

/** 有 cycle 時看 cycle，否則看全部 agent；只做設定層的保守檢查。 */
function assertModelsPresent(cfg: RawConfig): void {
  const agents = agentsOf(cfg);
  const affected = (cfg.cycle as string[] | undefined) ?? Object.keys(agents);
  const missing = affected.filter((name) => !agents[name] || !modelsOf(agents[name]).length);
  if (missing.length) throw new Error(`以下 agent 缺少模型：${missing.join("、")}`);
}

export function removeModel(cfg: RawConfig, agent: string, name: string): RawConfig {
  const next = withAgent(cfg, agent, (def) => {
    const models = modelsOf(def);
    if (!models.some((m) => m.name === name)) throw new Error(`agent ${agent} 沒有模型 ${name}`);
    return { ...def, models: models.filter((m) => m.name !== name) };
  });
  if (((cfg.modelSelection ?? {}) as { mode?: string }).mode === "adaptive") assertModelsPresent(next);
  return next;
}

export function setModelMode(cfg: RawConfig, mode: "balanced" | "adaptive"): RawConfig {
  if (mode !== "balanced" && mode !== "adaptive") throw new Error(`未知的模型模式：${mode}`);
  if (mode === "adaptive") assertModelsPresent(cfg);
  const next = { ...cfg, modelSelection: { ...((cfg.modelSelection ?? {}) as Record<string, unknown>), mode } };
  RepoConfig.parse(next);
  return next;
}

export function setStageStrength(cfg: RawConfig, stage: z.infer<typeof ModelStage>, strength: Strength): RawConfig {
  const parsed = ModelStage.safeParse(stage);
  if (!parsed.success) throw new Error(`未知的 LLM 階段：${stage}`);
  ModelStrength.parse(strength);
  const selection = (cfg.modelSelection ?? {}) as Record<string, unknown>;
  const next = { ...cfg, modelSelection: { ...selection, stageStrength: { ...((selection.stageStrength ?? {}) as Record<string, unknown>), [stage]: strength } } };
  RepoConfig.parse(next);
  return next;
}
