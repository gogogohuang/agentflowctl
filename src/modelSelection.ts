import type { FlowRun, ModelStage, ModelStrength, RepoConfig } from "./schemas.js";

const LEVEL: Record<ModelStrength, number> = { low: 0, medium: 1, high: 2 };
const STRENGTHS: ModelStrength[] = ["low", "medium", "high"];

/** 支援小組審查與索引審查的步驟名稱。 */
type ReviewStep = "plan-review" | "plan-review-group" | "review";

export const DEFAULT_STAGE_STRENGTH: Record<ModelStage, ModelStrength> = {
  spec: "medium", plan: "high", planReview: "high", planFix: "medium", planArbiter: "high",
  taskTests: "low", taskCode: "low", taskReview: "medium", taskFix: "low", fix: "medium", review: "high", diverge: "low",
};

export function effectiveStageStrengths(cfg: RepoConfig): Record<ModelStage, { strength: ModelStrength; custom: boolean }> {
  const custom = cfg.modelSelection.stageStrength;
  return Object.fromEntries((Object.keys(DEFAULT_STAGE_STRENGTH) as ModelStage[]).map((stage) =>
    [stage, { strength: custom[stage] ?? DEFAULT_STAGE_STRENGTH[stage], custom: custom[stage] !== undefined }])) as Record<ModelStage, { strength: ModelStrength; custom: boolean }>;
}

export interface SelectedModel {
  name?: string;
  effort?: string;
  strength?: ModelStrength;
  targetStrength?: ModelStrength;
  insufficient: boolean;
  mode: "balanced" | "adaptive";
}

/**
 * 審查失敗計數的鍵。scope 是任務群 id：一群失敗只讓同一群的下一次審查升級，不牽動同一輪的其他群。
 * 鍵一律以步驟名稱開頭，clearModelReviewStage 才能用前綴一次清掉。
 */
function reviewFailureKey(step: ReviewStep, reviewer: string, scope?: string): string {
  return scope ? `${step}:${scope}:${reviewer}` : `${step}:${reviewer}`;
}

/** 小組審查失敗只影響該審查者的下一次選模。 */
export function recordModelReviewFailure(run: FlowRun, step: ReviewStep, reviewer: string, scope?: string): FlowRun {
  const key = reviewFailureKey(step, reviewer, scope);
  return { ...run, modelRetryAttempts: { ...run.modelRetryAttempts, [key]: (run.modelRetryAttempts?.[key] ?? 0) + 1 } };
}

export function clearModelReviewFailure(run: FlowRun, step: ReviewStep, reviewer: string, scope?: string): FlowRun {
  const attempts = { ...run.modelRetryAttempts };
  delete attempts[reviewFailureKey(step, reviewer, scope)];
  return { ...run, modelRetryAttempts: attempts };
}

export function clearModelReviewStage(run: FlowRun, step: "plan-review" | "review"): FlowRun {
  const prefixes = step === "plan-review" ? ["plan-review:", "plan-review-group:"] : ["review:"];
  const attempts = Object.fromEntries(
    Object.entries(run.modelRetryAttempts ?? {}).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))),
  );
  return { ...run, modelRetryAttempts: attempts };
}

/** 把步驟名稱（例如 `T-1-code`、`plan-review`、`plan-review-group`）對應到階段鍵；不認得時回傳 undefined。 */
export function stageOfStep(step: string): ModelStage | undefined {
  const task = /^T-\d+-(tests|code|review|fix)$/.exec(step);
  if (task) return ({ tests: "taskTests", code: "taskCode", review: "taskReview", fix: "taskFix" } as const)[task[1] as "tests" | "code" | "review" | "fix"];
  if (/^T-\d+-diverge(?:-[a-z]+)?$/.test(step)) return "diverge";
  const stage: Record<string, ModelStage> = {
    spec: "spec", detect: "spec", plan: "plan", "plan-review": "planReview", "plan-review-group": "planReview", "plan-fix": "planFix",
    "plan-arbiter": "planArbiter", fix: "fix", review: "review",
  };
  return stage[step];
}

function stepStage(step: string): ModelStage {
  const found = stageOfStep(step);
  if (!found) throw new Error(`未知的 LLM 步驟：${step}`);
  return found;
}

function escalation(run: FlowRun, stage: ModelStage, step: string, reviewer?: string, scope?: string): number {
  const a = run.attempts;
  if (stage === "planReview" || stage === "review") return run.modelRetryAttempts?.[reviewFailureKey(step as ReviewStep, reviewer ?? "", scope)] ?? 0;
  if (stage === "planArbiter" || stage === "diverge") return 0;
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
  complexity?: ModelStrength, reviewer?: string, scope?: string,
): SelectedModel {
  const def = cfg.agents[agent];
  if (!def) throw new Error(`未定義的 agent：${agent}`);
  const mode = run.modelMode ?? "balanced";
  if (mode === "balanced") {
    const fallback = def.adapter === "command" ? undefined : cfg.defaultModels[def.adapter];
    return { mode, name: def.model ?? fallback, effort: def.effort, insufficient: false };
  }
  if (!def.models?.length) throw new Error(`agent ${agent} 沒有設定 models`);
  const stage = stepStage(step);
  const floor = effectiveStageStrengths(cfg)[stage].strength;
  const baseline = stage.startsWith("task") ? Math.max(LEVEL[floor], LEVEL[complexity ?? "medium"]) : LEVEL[floor];
  const targetStrength = STRENGTHS[Math.min(2, baseline + escalation(run, stage, step, reviewer, scope))]!;
  const candidates = def.models.filter((m) => LEVEL[m.strength] >= LEVEL[targetStrength]);
  const min = Math.min(...candidates.map((m) => LEVEL[m.strength]));
  const chosen = candidates.find((m) => LEVEL[m.strength] === min)
    ?? def.models.reduce((best, current) => LEVEL[current.strength] > LEVEL[best.strength] ? current : best);
  return { mode, name: chosen.name, effort: chosen.effort ?? def.effort, strength: chosen.strength, targetStrength, insufficient: LEVEL[chosen.strength] < LEVEL[targetStrength] };
}

/** adaptive 模式下缺少 models 的錯誤說明：列出全部 agent，並給兩種修法 */
export function missingModelsMessage(names: string[]): string {
  return [
    `目前是 adaptive 模式，但以下 agent 沒有登記 models（adaptive 只看 models，不看 model）：${names.join("、")}`,
    "  修法一：登記模型與強度（會用目前帳號送一個短請求驗證）",
    ...names.map((n) => `    agentflowctl config agent model add ${n} <模型名稱> --strength low|medium|high`),
    "  修法二：改用 balanced，沿用各 agent 的 model",
    "    agentflowctl config selection mode balanced（只改這次 run：run --model-mode balanced）",
  ].join("\n");
}

/** 啟用 adaptive 前檢查本次實際參與的 agent。 */
export function validateAdaptiveConfig(cfg: RepoConfig, cycle: string[]): void {
  const lacking = cycle.filter((name) => cfg.agents[name] && !cfg.agents[name]!.models?.length);
  if (lacking.length) throw new Error(missingModelsMessage(lacking));
  for (const name of cycle) {
    const def = cfg.agents[name];
    if (!def) throw new Error(`未定義的 agent：${name}`);
    const keys = (def.models ?? []).map((m) => `${m.name}\0${m.strength}`);
    if (new Set(keys).size !== keys.length) throw new Error(`agent ${name} 的 models 有重複的名稱與強度`);
    if (def.adapter === "command") {
      if (!def.command?.some((arg) => arg.includes("{model}"))) throw new Error(`agent ${name} 的 command 缺少 {model}`);
      if (!def.modelProbe?.length || !def.modelProbe.some((arg) => arg.includes("{model}"))) throw new Error(`agent ${name} 的 modelProbe 缺少 {model}`);
    } else if (def.extraArgs.some((arg, index) => {
      if (arg === "--model" || arg === "-m" || arg.startsWith("--model=") || arg === "--effort" || arg.startsWith("--effort=")) return true;
      if (def.adapter !== "codex") return false;
      const override = arg === "-c" || arg === "--config" ? def.extraArgs[index + 1]
        : arg.startsWith("--config=") ? arg.slice("--config=".length)
        : arg.startsWith("-c") ? arg.slice(2).replace(/^=/, "") : undefined;
      return override !== undefined && /^\s*model_reasoning_effort\s*=/.test(override);
    })) {
      throw new Error(`agent ${name} 的 extraArgs 與 adaptive 模型參數衝突`);
    }
  }
}
