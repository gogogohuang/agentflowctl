import type { RetryEntry, UsageEntry, UsageSummary } from "./store.js";
import { summarizeUsage, totalUsage, usageKeyAgent, usageKeyModelStage, usageKeyStage, usageKeyStrength, usageKeyTask } from "./store.js";

export interface UsageInsightsInputRun {
  id: string;
  usage: UsageEntry[];
  retries: RetryEntry[];
  substitutions: number;
}

export interface Finding {
  code: string;
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
  substitutions: number;
  findings: Finding[];
  runs: { id: string; tokens: number; calls: number }[];
}

export function computeUsageInsights(runs: UsageInsightsInputRun[]): UsageInsights {
  const usage = runs.flatMap((r) => r.usage);
  const substitutions = runs.reduce((n, r) => n + r.substitutions, 0);
  const total = totalUsage(usage);
  return {
    total,
    byStrength: summarizeUsage(usage, usageKeyStrength),
    byStage: summarizeUsage(usage, usageKeyStage),
    byTask: summarizeUsage(usage, usageKeyTask),
    byAgent: summarizeUsage(usage, usageKeyAgent),
    byModelStage: summarizeUsage(usage, usageKeyModelStage),
    substitutions,
    findings: [],
    runs: runs.map((r) => {
      const t = totalUsage(r.usage);
      return { id: r.id, tokens: t.tokens, calls: t.runs };
    }),
  };
}
