import { retryLabel } from "./insights.js";
import { RetryCategories, type RetryCategory, type RetryEntry, type UsageEntry, type UsageSummary } from "./store.js";
import { summarizeUsage, totalUsage, usageKeyAgent, usageKeyModelStage, usageKeyStage, usageKeyStrength, usageKeyTask } from "./store.js";
import { mergeStats, type RunStats, type StepStat } from "./stats.js";

export const FindingCodes = [
  "coverage_low", "high_strength_share", "retry_waste", "input_heavy",
  "hot_stage", "hot_task", "substitution_waste", "cache_unread",
  "hot_model_step", "hot_failing_step",
] as const;
export type FindingCode = (typeof FindingCodes)[number];

export const FINDING_LABEL: Record<FindingCode, string> = {
  coverage_low: "用量回報不完整",
  high_strength_share: "高強度模型占比偏高",
  retry_waste: "重試可能比單次 prompt 更耗 token",
  input_heavy: "輸入遠大於輸出",
  hot_stage: "單一階段佔用量過高",
  hot_task: "單一任務佔用量過高",
  substitution_waste: "額度代打造成重做",
  cache_unread: "cache 寫入多、讀取少",
  hot_model_step: "單一模型與步驟佔用量過高",
  hot_failing_step: "單一執行步驟失敗次數過多",
};

export interface UsageInsightsInputRun {
  id: string;
  usage: UsageEntry[];
  retries: RetryEntry[];
  substitutions: number;
  stats?: RunStats;
}

export interface Finding {
  code: FindingCode;
  impactTokens: number;
  title: string;
  detail: string;
}

export interface UsageInsights {
  total: UsageSummary;
  byStrength: Record<string, UsageSummary>;
  byStage: Record<string, UsageSummary>;
  byTask: Record<string, UsageSummary>;
  byAgent: Record<string, UsageSummary>;
  byModelStage: Record<string, UsageSummary>;
  stepStats: ReturnType<typeof mergeStats>;
  substitutions: number;
  findings: Finding[];
  runs: { id: string; tokens: number; calls: number }[];
}

const pct = (part: number, whole: number) => (whole ? `${(part / whole * 100).toFixed(1)}%` : "無法計算");

function topByTokens(record: Record<string, UsageSummary>, exclude: string[] = []): [string, UsageSummary] | undefined {
  return Object.entries(record)
    .filter(([key, v]) => !exclude.includes(key) && v.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)[0];
}

export function usageFindings(input: {
  total: UsageSummary;
  byStrength: Record<string, UsageSummary>;
  byStage: Record<string, UsageSummary>;
  byTask: Record<string, UsageSummary>;
  retries: RetryEntry[];
  substitutions: number;
  byModelStage?: Record<string, UsageSummary>;
  steps?: StepStat[];
}): Finding[] {
  const { total, byStrength, byStage, byTask, retries, substitutions, byModelStage = {}, steps = [] } = input;
  const out: Finding[] = [];
  const avg = total.reportedRuns ? Math.round(total.tokens / total.reportedRuns) : 0;
  const unknownCalls = total.unreportedRuns + total.legacyRuns;

  if (total.runs >= 5 && unknownCalls / total.runs >= 0.3) {
    out.push({
      code: "coverage_low", impactTokens: 0, title: FINDING_LABEL.coverage_low,
      detail: `${unknownCalls} / ${total.runs} 次呼叫沒有明確 token。強度占比可能失真，先看未回報的 agent。`,
    });
  }

  const high = byStrength.high;
  if (total.tokens > 0 && high && high.tokens / total.tokens >= 0.4) {
    out.push({
      code: "high_strength_share", impactTokens: high.tokens, title: FINDING_LABEL.high_strength_share,
      detail: `high 佔已回報 token 的 ${pct(high.tokens, total.tokens)}，呼叫 ${high.runs} 次。合計 token 不是主指標；可查 model stage 與任務 complexity。`,
    });
  }

  if (retries.length >= 2) {
    const cat = new Map<RetryCategory, number>();
    for (const r of retries) cat.set(r.category, (cat.get(r.category) ?? 0) + 1);
    const top = [...cat.entries()].sort((a, b) => b[1] - a[1] || RetryCategories.indexOf(a[0]) - RetryCategories.indexOf(b[0]))[0];
    const waste = avg * retries.length;
    out.push({
      code: "retry_waste", impactTokens: waste, title: FINDING_LABEL.retry_waste,
      detail: `重試 ${retries.length} 次，最多「${top ? retryLabel(top[0]) : "未知"}」（${top?.[1] ?? 0} 次）。以平均每次 ${avg} tokens 估算，重試約 ${waste} tokens。先改該關卡，再縮 prompt。`,
    });
  }

  if (total.tokens >= 5000 && total.inputTokens / total.tokens >= 0.85) {
    out.push({
      code: "input_heavy", impactTokens: total.inputTokens, title: FINDING_LABEL.input_heavy,
      detail: `輸入 ${total.inputTokens}、輸出 ${total.outputTokens}（輸入佔 ${pct(total.inputTokens, total.tokens)}）。上下文可能太大：規格、計畫、測試輸出或一次讀太多檔。`,
    });
  }

  const stagesWithTokens = Object.values(byStage).filter((s) => s.tokens > 0).length;
  const topStage = topByTokens(byStage);
  if (total.tokens > 0 && stagesWithTokens >= 2 && topStage && topStage[1].tokens / total.tokens >= 0.35) {
    out.push({
      code: "hot_stage", impactTokens: topStage[1].tokens, title: FINDING_LABEL.hot_stage,
      detail: `${topStage[0]} 佔 ${pct(topStage[1].tokens, total.tokens)}（${topStage[1].tokens} tokens，${topStage[1].runs} 次）。改該階段 prompt 或最低強度。`,
    });
  }

  const taskEntries = Object.entries(byTask).filter(([key]) => key !== "非任務步驟");
  const taskTotal = taskEntries.reduce((n, [, v]) => n + v.tokens, 0);
  const tasksWithTokens = taskEntries.filter(([, v]) => v.tokens > 0).length;
  const topTask = topByTokens(byTask, ["非任務步驟"]);
  if (taskTotal > 0 && tasksWithTokens >= 2 && topTask && topTask[1].tokens / taskTotal >= 0.4) {
    out.push({
      code: "hot_task", impactTokens: topTask[1].tokens, title: FINDING_LABEL.hot_task,
      detail: `${topTask[0]} 佔任務用量 ${pct(topTask[1].tokens, taskTotal)}（${topTask[1].tokens} tokens）。考慮切小任務或降低 complexity。`,
    });
  }

  if (substitutions >= 2) {
    out.push({
      code: "substitution_waste", impactTokens: avg * substitutions, title: FINDING_LABEL.substitution_waste,
      detail: `代打 ${substitutions} 次。寫入步驟額度用完會還原半成品再換人，等於重跑。`,
    });
  }

  if (total.cacheWriteTokens >= 1000 && total.cacheReadTokens < total.cacheWriteTokens * 0.5) {
    out.push({
      code: "cache_unread", impactTokens: total.cacheWriteTokens, title: FINDING_LABEL.cache_unread,
      detail: `cache 寫 ${total.cacheWriteTokens}、讀 ${total.cacheReadTokens}。合計 token 含 cache，讀取少時較不像在吃快取。`,
    });
  }

  const modelGroups = Object.values(byModelStage).filter((s) => s.tokens > 0).length;
  const topModel = topByTokens(byModelStage);
  if (total.tokens > 0 && modelGroups >= 2 && topModel && topModel[1].tokens / total.tokens >= 0.35) {
    out.push({
      code: "hot_model_step", impactTokens: topModel[1].tokens, title: FINDING_LABEL.hot_model_step,
      detail: `${topModel[0]} 佔 ${pct(topModel[1].tokens, total.tokens)}（${topModel[1].tokens} tokens，${topModel[1].runs} 次）。可換模型或只調該步驟強度。`,
    });
  }

  const topFail = (() => {
    const candidates = steps.filter((s) => s.failed >= 3).sort((a, b) => b.failed - a.failed || b.runs - a.runs);
    return candidates.find((s) => s.kind === "agent") ?? candidates[0];
  })();
  if (topFail) {
    const kindLabel = topFail.kind === "cmd" ? "專案指令" : "agent";
    out.push({
      code: "hot_failing_step",
      impactTokens: topFail.kind === "agent" ? avg * topFail.failed : 0,
      title: FINDING_LABEL.hot_failing_step,
      detail: `${topFail.step}（${kindLabel}）失敗 ${topFail.failed} / ${topFail.runs} 次。先看該步驟的 stats 與 logs，再改 prompt 或檢查指令。`,
    });
  }

  const coverage = out.filter((f) => f.code === "coverage_low");
  const rest = out
    .filter((f) => f.code !== "coverage_low")
    .sort((a, b) => b.impactTokens - a.impactTokens || FindingCodes.indexOf(a.code) - FindingCodes.indexOf(b.code));
  return [...coverage, ...rest].slice(0, 5);
}

export function computeUsageInsights(runs: UsageInsightsInputRun[]): UsageInsights {
  const usage = runs.flatMap((r) => r.usage);
  const retries = runs.flatMap((r) => r.retries);
  const substitutions = runs.reduce((n, r) => n + r.substitutions, 0);
  const emptyStats = (): RunStats => ({ steps: [], agentMs: 0, cmdMs: 0, wallMs: 0, unfinished: 0 });
  const stepStats = mergeStats(runs.map((r) => r.stats ?? emptyStats()));
  const total = totalUsage(usage);
  const byStrength = summarizeUsage(usage, usageKeyStrength);
  const byStage = summarizeUsage(usage, usageKeyStage);
  const byTask = summarizeUsage(usage, usageKeyTask);
  const byAgent = summarizeUsage(usage, usageKeyAgent);
  const byModelStage = summarizeUsage(usage, usageKeyModelStage);
  return {
    total,
    byStrength,
    byStage,
    byTask,
    byAgent,
    byModelStage,
    stepStats,
    substitutions,
    findings: usageFindings({ total, byStrength, byStage, byTask, byModelStage, retries, substitutions, steps: stepStats.steps }),
    runs: runs.map((r) => {
      const t = totalUsage(r.usage);
      return { id: r.id, tokens: t.tokens, calls: t.runs };
    }),
  };
}
