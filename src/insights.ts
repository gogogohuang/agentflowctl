import { RetryCategories, type RetryCategory, type RetryEntry } from "./store.js";

export const RETRY_LABEL: Record<RetryCategory, string> = {
  agent_error: "Agent 執行失敗",
  missing_artifact: "缺少必要檔案",
  format_invalid: "輸出格式錯誤",
  handoff_invalid: "交接回覆不合格",
  open_handoff: "未結交接事項",
  review_changes: "審查要求修改",
  plan_tampered: "改動已鎖定的計畫檔",
  tests_not_written: "未寫測試",
  tests_not_red: "紅燈測試未失敗",
  tests_modified: "實作改了測試",
  tests_not_green: "測試仍未通過",
  tests_deleted: "刪除測試檔",
  checks_failed: "專案檢查失敗",
};

export interface InsightsInputRun {
  id: string;
  stage: string;
  retries: RetryEntry[];
}

const OUTCOMES = ["done", "failed", "paused", "awaiting_approval"] as const;
type Outcome = (typeof OUTCOMES)[number] | "active";

export function outcomeOf(stage: string): Outcome {
  return (OUTCOMES as readonly string[]).includes(stage) ? stage as Exclude<Outcome, "active"> : "active";
}

export interface Insights {
  runCount: number;
  byOutcome: Record<Outcome, number>;
  byCategory: { category: RetryCategory; count: number; finals: number }[];
  byKey: { key: string; count: number }[];
  runs: { id: string; stage: string; retries: number; topCategory?: RetryCategory }[];
}

export function computeInsights(runs: InsightsInputRun[]): Insights {
  const byOutcome: Record<Outcome, number> = { done: 0, failed: 0, paused: 0, awaiting_approval: 0, active: 0 };
  const cat = new Map<RetryCategory, { count: number; finals: number }>();
  const keys = new Map<string, number>();
  for (const run of runs) {
    byOutcome[outcomeOf(run.stage)] += 1;
    for (const r of run.retries) {
      const cur = cat.get(r.category) ?? { count: 0, finals: 0 };
      cur.count += 1;
      if (r.final) cur.finals += 1;
      cat.set(r.category, cur);
      keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
    }
  }
  const topOf = (retries: RetryEntry[]) => {
    const n = new Map<RetryCategory, number>();
    for (const r of retries) n.set(r.category, (n.get(r.category) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || RetryCategories.indexOf(a[0]) - RetryCategories.indexOf(b[0]))[0]?.[0];
  };
  return {
    runCount: runs.length,
    byOutcome,
    byCategory: [...cat.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.count - a.count),
    byKey: [...keys.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    runs: runs.map((r) => ({ id: r.id, stage: r.stage, retries: r.retries.length, topCategory: topOf(r.retries) })),
  };
}
