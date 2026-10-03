import type { FailureCategory } from "./schemas.js";
import { RetryCategories, type RetryCategory, type RetryEntry } from "./store.js";

export const RETRY_LABEL: Record<RetryCategory, string> = {
  agent_error: "Agent 執行失敗",
  missing_artifact: "缺少必要檔案",
  format_invalid: "輸出格式錯誤",
  handoff_invalid: "交接回覆不合格",
  open_handoff: "未結交接事項",
  review_changes: "審查要求修改",
  arbitration_revise: "仲裁要求修訂",
  plan_tampered: "改動已鎖定的計畫檔",
  tests_not_written: "未寫測試",
  code_not_written: "未實作",
  tests_not_red: "紅燈測試未失敗",
  tests_modified: "實作改了測試",
  tests_not_green: "測試仍未通過",
  tests_invalid: "測試本身有問題，退回重寫",
  tests_deleted: "刪除測試檔",
  out_of_scope: "動到後面任務的檔案",
  merge_conflict: "平行任務合併衝突",
  merge_tests_failed: "平行任務合併後測試失敗",
  checks_failed: "專案檢查失敗",
  amend_invalid: "修補請求不合格",
};

export const FAILURE_LABEL: Record<FailureCategory | "unknown", string> = {
  retry_limit: "關卡重試達上限",
  arbitration_stop: "仲裁停止",
  open_handoff: "PR 前仍有未結事項",
  agent_budget: "agent 次數用完",
  error: "執行時發生錯誤",
  cancelled: "使用者取消",
  unknown: "未分類（舊 run）",
};

/** 讀到較新版本寫入、這一版不認得的分類時，直接顯示代碼 */
export function retryLabel(category: string): string {
  return RETRY_LABEL[category as RetryCategory] ?? category;
}

export function failureLabel(category: string | undefined): string {
  return FAILURE_LABEL[(category ?? "unknown") as FailureCategory] ?? category!;
}

const TASK_PHASES = ["tests", "code", "review", "review-run", "verify", "fix"];

/** 任務關卡的 key 帶有 task id（T1:tests），跨 run 彙總時合併成同一種關卡 */
export function gateOf(key: string): string {
  const i = key.lastIndexOf(":");
  if (i < 0) return key;
  const phase = key.slice(i + 1);
  return TASK_PHASES.includes(phase) ? `任務:${phase}` : key;
}

export interface InsightsInputRun {
  id: string;
  stage: string;
  failureCategory?: FailureCategory;
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
  /** 失敗的 run 依失敗原因加總；舊 run 沒有紀錄時歸為 unknown */
  byFailure: { category: FailureCategory | "unknown"; count: number }[];
  byCategory: { category: RetryCategory; count: number; finals: number }[];
  byGate: { gate: string; count: number }[];
  runs: { id: string; stage: string; retries: number; topCategory?: RetryCategory }[];
}

const countDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

export function computeInsights(runs: InsightsInputRun[]): Insights {
  const byOutcome: Record<Outcome, number> = { done: 0, failed: 0, paused: 0, awaiting_approval: 0, active: 0 };
  const failures = new Map<FailureCategory | "unknown", number>();
  const cat = new Map<RetryCategory, { count: number; finals: number }>();
  const gates = new Map<string, number>();
  for (const run of runs) {
    const outcome = outcomeOf(run.stage);
    byOutcome[outcome] += 1;
    if (outcome === "failed") {
      const f = run.failureCategory ?? "unknown";
      failures.set(f, (failures.get(f) ?? 0) + 1);
    }
    for (const r of run.retries) {
      const cur = cat.get(r.category) ?? { count: 0, finals: 0 };
      cur.count += 1;
      if (r.final) cur.finals += 1;
      cat.set(r.category, cur);
      const gate = gateOf(r.key);
      gates.set(gate, (gates.get(gate) ?? 0) + 1);
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
    byFailure: [...failures.entries()].map(([category, count]) => ({ category, count })).sort(countDesc),
    byCategory: [...cat.entries()].map(([category, v]) => ({ category, ...v })).sort(countDesc),
    byGate: [...gates.entries()].map(([gate, count]) => ({ gate, count })).sort(countDesc),
    runs: runs.map((r) => ({ id: r.id, stage: r.stage, retries: r.retries.length, topCategory: topOf(r.retries) })),
  };
}
