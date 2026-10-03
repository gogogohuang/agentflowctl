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
  checks_weakened: "繞過檢查（skip、suppress、斷言減少）",
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

/**
 * 失敗類別對應到該去看哪些規則（prompt、程式碼、設定）與怎麼想。
 * 改規則時在這裡找對應的類別，就知道它是為了擋哪種失敗；某類失敗反覆出現時，`insights` 也靠它指出該改哪裡。
 * 新增 RetryCategory 時 TypeScript 會要求補上這裡。
 */
export const RETRY_RULES: Record<RetryCategory, { rules: string[]; hint: string }> = {
  agent_error: { rules: ["flow.config.json 的 agents 與 CLI 版本（config doctor）", "runner.ts 的 QUOTA_PATTERNS"], hint: "CLI 本身執行失敗，先看 log 的錯誤訊息，不是 prompt 問題" },
  missing_artifact: { rules: ["對應階段 prompt 的 <output_format>"], hint: "agent 沒有產出要求的檔案，檢查 prompt 是否寫清楚要寫到哪裡" },
  format_invalid: { rules: ["對應階段 prompt 的 <output_format>", "schemas.ts 的 zod schema"], hint: "輸出格式不合；schema 是否過嚴、prompt 的範例是否與 schema 一致" },
  handoff_invalid: { rules: ["各 prompt 的 <handoff> 區段", "handoff.ts"], hint: "交接回覆格式或內容不合格" },
  open_handoff: { rules: ["review.md／task-review.md 的 <handoff>", "handoff.ts 的 reviewHandoffGate"], hint: "審查核准時仍有未結事項，審查者沒有逐項處置" },
  review_changes: { rules: ["prompts/review.md、task-review.md 的 <review_focus>", "prompts/implement-code.md"], hint: "審查常要求修改：實作 prompt 是否漏掉審查反覆挑出的重點，或審查標準是否過嚴" },
  arbitration_revise: { rules: ["prompts/plan.md", "prompts/plan-arbiter.md"], hint: "計畫被仲裁退回：計畫 prompt 是否漏掉仲裁者反覆指出的缺口" },
  plan_tampered: { rules: ["fix.md、implement-*.md 的 <constraints>"], hint: "agent 改了已鎖定的規格與計畫檔，檢查限制是否寫得夠明確" },
  tests_not_written: { rules: ["prompts/implement-tests.md"], hint: "測試階段沒寫出符合 testPattern 的測試檔" },
  code_not_written: { rules: ["prompts/implement-direct.md"], hint: "舊版分類：不走 TDD 的任務沒有 commit" },
  tests_not_red: { rules: ["prompts/implement-tests.md", "tasks.ts 的 descriptionWaivesRed", "prompts/plan.md 的 tdd 旗標說明"], hint: "測試一開始就通過：任務是否該標 tdd:false，或行為早就存在" },
  tests_modified: { rules: ["prompts/implement-code.md"], hint: "綠燈階段實作者改了測試檔" },
  checks_weakened: { rules: ["prompts/fix.md", "prompts/implement-code.md", "testGuard.ts 的 weakenedChecks"], hint: "agent 用 skip、抑制註解或減少斷言讓檢查通過；看是不是檢查本身太難滿足" },
  tests_not_green: { rules: ["prompts/implement-code.md", "prompts/implement-tests.md"], hint: "實作後測試仍失敗：測試是否寫得難以滿足，或任務切太大" },
  tests_invalid: { rules: ["prompts/implement-tests.md", "packageExports.ts"], hint: "測試用了專案沒有的 API，退回重寫" },
  tests_deleted: { rules: ["prompts/fix.md"], hint: "修正時刪除測試檔" },
  out_of_scope: { rules: ["prompts/plan.md（任務切分與 description 寫明檔案）", "tasks.ts 的 outOfScopeFiles"], hint: "動到後面任務的檔案：任務 description 是否寫明各自負責的檔案" },
  checks_failed: { rules: ["flow.config.json 的 checks／test", "rerunFailedChecks"], hint: "專案檢查失敗；若 flaky 清單也有同一個檢查，先修那個檢查" },
  merge_conflict: { rules: ["prompts/plan.md 的 dependsOn 規則", "tasks.ts 的 overlappingParallelTasks"], hint: "平行任務合併衝突：共用檔案的任務是否沒排出先後" },
  merge_tests_failed: { rules: ["prompts/plan.md 的 dependsOn 規則"], hint: "合併後全套測試失敗：任務之間有語意相依（標籤、文案、共用函式）卻沒排出先後" },
  amend_invalid: { rules: ["prompts/implement-*.md 的修補請求說明", "engine.ts 的 decideAmend"], hint: "修補請求格式或內容不合格" },
};

/** 同一類重試累積這麼多次、且分散在這麼多個 run，才算「反覆出現」 */
export const HOTSPOT_MIN_COUNT = 3;
export const HOTSPOT_MIN_RUNS = 2;

export interface InsightsInputRun {
  id: string;
  stage: string;
  failureCategory?: FailureCategory;
  retries: RetryEntry[];
  /** 第一次失敗、原樣重跑通過的檢查；舊 run 沒有 */
  flaky?: { check: string }[];
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
  /** 反覆出現的重試類別（跨多個 run），附上對應的規則；依次數排序 */
  hotspots: { category: RetryCategory; count: number; runs: number; rules: string[]; hint: string }[];
  /** 不穩定的檢查（第一次失敗、重跑通過）依檢查名稱加總 */
  flaky: { check: string; count: number }[];
}

const countDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

export function computeInsights(runs: InsightsInputRun[]): Insights {
  const byOutcome: Record<Outcome, number> = { done: 0, failed: 0, paused: 0, awaiting_approval: 0, active: 0 };
  const failures = new Map<FailureCategory | "unknown", number>();
  const cat = new Map<RetryCategory, { count: number; finals: number }>();
  const gates = new Map<string, number>();
  const runsPerCategory = new Map<RetryCategory, Set<string>>();
  const flaky = new Map<string, number>();
  for (const run of runs) {
    for (const f of run.flaky ?? []) flaky.set(f.check, (flaky.get(f.check) ?? 0) + 1);
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
      runsPerCategory.set(r.category, (runsPerCategory.get(r.category) ?? new Set()).add(run.id));
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
    hotspots: [...cat.entries()]
      .map(([category, v]) => ({ category, count: v.count, runs: runsPerCategory.get(category)?.size ?? 0, ...RETRY_RULES[category] }))
      .filter((h) => h.count >= HOTSPOT_MIN_COUNT && h.runs >= HOTSPOT_MIN_RUNS)
      .sort(countDesc),
    flaky: [...flaky.entries()].map(([check, count]) => ({ check, count })).sort(countDesc),
  };
}
