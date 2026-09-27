import type { FlowRun, ModelStage, ModelStrength, RepoConfig } from "./schemas.js";

const LEVEL: Record<ModelStrength, number> = { low: 0, medium: 1, high: 2 };
const STRENGTHS: ModelStrength[] = ["low", "medium", "high"];

export const DEFAULT_STAGE_STRENGTH: Record<ModelStage, ModelStrength> = {
  spec: "medium", plan: "high", planReview: "high", planFix: "medium", planArbiter: "high",
  taskTests: "low", taskCode: "low", taskReview: "medium", taskFix: "low", fix: "medium", review: "high",
};

export function effectiveStageStrengths(cfg: RepoConfig): Record<ModelStage, { strength: ModelStrength; custom: boolean }> {
  const custom = cfg.modelSelection.stageStrength;
  return Object.fromEntries((Object.keys(DEFAULT_STAGE_STRENGTH) as ModelStage[]).map((stage) =>
    [stage, { strength: custom[stage] ?? DEFAULT_STAGE_STRENGTH[stage], custom: custom[stage] !== undefined }])) as Record<ModelStage, { strength: ModelStrength; custom: boolean }>;
}

export interface SelectedModel {
  name?: string;
  strength?: ModelStrength;
  targetStrength?: ModelStrength;
  insufficient: boolean;
  mode: "balanced" | "adaptive";
}

/** 小組審查失敗只影響該審查者的下一次選模。 */
export function recordModelReviewFailure(run: FlowRun, step: "plan-review" | "review", reviewer: string): FlowRun {
  const key = `${step}:${reviewer}`;
  return { ...run, modelRetryAttempts: { ...run.modelRetryAttempts, [key]: (run.modelRetryAttempts?.[key] ?? 0) + 1 } };
}

export function clearModelReviewFailure(run: FlowRun, step: "plan-review" | "review", reviewer: string): FlowRun {
  const attempts = { ...run.modelRetryAttempts };
  delete attempts[`${step}:${reviewer}`];
  return { ...run, modelRetryAttempts: attempts };
}

export function clearModelReviewStage(run: FlowRun, step: "plan-review" | "review"): FlowRun {
  const attempts = Object.fromEntries(Object.entries(run.modelRetryAttempts ?? {}).filter(([key]) => !key.startsWith(`${step}:`)));
  return { ...run, modelRetryAttempts: attempts };
}

/** 把步驟名稱（例如 `T-1-code`、`plan-review`）對應到階段鍵；不認得時回傳 undefined。 */
export function stageOfStep(step: string): ModelStage | undefined {
  const task = /^T-\d+-(tests|code|review|fix)$/.exec(step);
  if (task) return ({ tests: "taskTests", code: "taskCode", review: "taskReview", fix: "taskFix" } as const)[task[1] as "tests" | "code" | "review" | "fix"];
  const stage: Record<string, ModelStage> = {
    spec: "spec", plan: "plan", "plan-review": "planReview", "plan-fix": "planFix",
    "plan-arbiter": "planArbiter", fix: "fix", review: "review",
  };
  return stage[step];
}

function stepStage(step: string): ModelStage {
  const found = stageOfStep(step);
  if (!found) throw new Error(`未知的 LLM 步驟：${step}`);
  return found;
}

function escalation(run: FlowRun, stage: ModelStage, step: string, reviewer?: string): number {
  const a = run.attempts;
  if (stage === "planReview" || stage === "review") return run.modelRetryAttempts?.[`${step}:${reviewer ?? ""}`] ?? 0;
  if (stage === "planArbiter") return 0;
  if (stage === "planFix") return (a["plan-fix"] ?? 0) + Math.max((a["plan-review"] ?? 0) + (a["plan-handoff"] ?? 0) - 1, 0);
  if (stage === "taskFix") {
    const id = step.slice(0, -4);
    return (a[`${id}:fix`] ?? 0) + Math.max((a[`${id}:review`] ?? 0) + (a[`${id}:verify`] ?? 0) - 1, 0);
  }
  if (stage === "fix") return (a.fix ?? 0) + Math.max((a.verify ?? 0) + (a.review ?? 0) - 1, 0);
  if (stage === "taskTests" || stage === "taskCode" || stage === "taskReview") {
    const id = step.slice(0, step.lastIndexOf("-"));
    const suffix = step.slice(step.lastIndexOf("-") + 1);
    return a[`${id}:${suffix === "review" ? "review-run" : suffix}`] ?? 0;
  }
  return a[step] ?? 0;
}

/** 每次呼叫前依目前設定與 run 狀態選擇模型；不修改任何狀態。 */
export function selectModel(
  run: FlowRun, cfg: RepoConfig, agent: string, step: string,
  complexity?: ModelStrength, reviewer?: string,
): SelectedModel {
  const def = cfg.agents[agent];
  if (!def) throw new Error(`未定義的 agent：${agent}`);
  const mode = run.modelMode ?? "balanced";
  if (mode === "balanced") {
    const fallback = def.adapter === "command" ? undefined : cfg.defaultModels[def.adapter];
    return { mode, name: def.model ?? fallback, insufficient: false };
  }
  if (!def.models?.length) throw new Error(`agent ${agent} 沒有設定 models`);
  const stage = stepStage(step);
  const floor = effectiveStageStrengths(cfg)[stage].strength;
  const baseline = stage.startsWith("task") ? Math.max(LEVEL[floor], LEVEL[complexity ?? "medium"]) : LEVEL[floor];
  const targetStrength = STRENGTHS[Math.min(2, baseline + escalation(run, stage, step, reviewer))]!;
  const candidates = def.models.filter((m) => LEVEL[m.strength] >= LEVEL[targetStrength]);
  const min = Math.min(...candidates.map((m) => LEVEL[m.strength]));
  const chosen = candidates.find((m) => LEVEL[m.strength] === min)
    ?? def.models.reduce((best, current) => LEVEL[current.strength] > LEVEL[best.strength] ? current : best);
  return { mode, name: chosen.name, strength: chosen.strength, targetStrength, insufficient: LEVEL[chosen.strength] < LEVEL[targetStrength] };
}

/** 啟用 adaptive 前檢查本次實際參與的 agent。 */
export function validateAdaptiveConfig(cfg: RepoConfig, cycle: string[]): void {
  for (const name of cycle) {
    const def = cfg.agents[name];
    if (!def) throw new Error(`未定義的 agent：${name}`);
    if (!def.models?.length) throw new Error(`agent ${name} 的 models 至少要有一個模型`);
    const names = def.models.map((m) => m.name);
    if (new Set(names).size !== names.length) throw new Error(`agent ${name} 的 models 有重複名稱`);
    if (def.adapter === "command") {
      if (!def.command?.some((arg) => arg.includes("{model}"))) throw new Error(`agent ${name} 的 command 缺少 {model}`);
      if (!def.modelProbe?.length || !def.modelProbe.some((arg) => arg.includes("{model}"))) throw new Error(`agent ${name} 的 modelProbe 缺少 {model}`);
    } else if (def.extraArgs.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))) {
      throw new Error(`agent ${name} 的 extraArgs 與 adaptive 模型參數衝突`);
    }
  }
}
