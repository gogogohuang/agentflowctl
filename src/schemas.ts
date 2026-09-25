import { z } from "zod";

export const Stage = z.enum([
  "spec",
  "plan",
  "plan_review",
  "plan_fix",
  "awaiting_approval",
  "implement",
  "verify",
  "fix",
  "review",
  "pr",
  "paused",
  "done",
  "failed",
]);
export type Stage = z.infer<typeof Stage>;

/** Agent 在 spec 階段產出的 .flow/acceptance.json */
export const AcceptanceList = z
  .array(
    z.object({
      id: z.string().regex(/^AC-\d+$/, "id 格式必須是 AC-<數字>"),
      description: z.string().min(1),
    }),
  )
  .min(1);

export const TaskItem = z.object({
  id: z.string().regex(/^T-\d+$/, "id 格式必須是 T-<數字>"),
  title: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1, "每個任務至少要對應一條驗收條件"),
});
export type TaskItem = z.infer<typeof TaskItem>;

/** Agent 在 plan 階段產出的 .flow/tasks.json */
export const TaskList = z.array(TaskItem).min(1);

/** Agent 在 review 階段產出的 .flow/review.json */
export const ReviewResult = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  items: z.array(
    z.object({
      criterion: z.string(),
      status: z.enum(["met", "not_met", "partial"]),
      note: z.string().default(""),
    }),
  ),
});

/** 一個 agent 的定義；名稱（agents 的 key）用在輪替順序裡 */
export const AgentDef = z.object({
  adapter: z.enum(["claude", "codex", "gemini", "command"]),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
  /** 只有 command adapter 使用，`{prompt}` 會被替換成 prompt */
  command: z.array(z.string()).optional(),
});
export type AgentDef = z.infer<typeof AgentDef>;

/** 目標專案可選的 flow.config.json，預設值對應 Vite + TypeScript + Vitest 專案 */
export const RepoConfig = z.object({
  /** 自訂或覆寫 agent；claude、codex、gemini 三個名稱內建 */
  agents: z.record(z.string(), AgentDef).default({}),
  /** 輪替順序；未設定時自動偵測已安裝的 CLI */
  cycle: z.array(z.string()).min(1).optional(),
  /** review 後的修正由誰做：ring＝輪到下一位；author＝最後寫程式的 agent */
  fixStrategy: z.enum(["ring", "author"]).default("ring"),
  /** TDD 的測試與實作交給不同的 agent */
  tddSplit: z.boolean().default(true),
  /** 需要幾位不同的 reviewer 都核准 */
  reviewQuorum: z.number().int().min(1).default(1),
  /** 計畫需要幾位不同的 reviewer 都核准 */
  planReviewQuorum: z.number().int().min(1).default(1),
  /** 計畫審查僵持不下（達到重試上限或意見不再變化）時，交給第三方 agent 仲裁，而不是停下來等人 */
  planArbiter: z.boolean().default(true),
  /**
   * 仲裁意見分歧時怎麼辦（只有兩家時由雙方各自仲裁，才可能分歧）：
   * proceed＝繼續實作，爭議記錄在計畫裡，後面還有測試、驗證與程式碼審查把關；stop＝停下來等人
   */
  tieBreak: z.enum(["proceed", "stop"]).default("proceed"),
  /** 單一 run 最多執行幾次 agent */
  maxAgentRuns: z.number().int().positive().default(60),
  install: z.string().default("npm install --no-audit --no-fund"),
  test: z.string().default("npx vitest run"),
  testPattern: z.string().default("\\.(test|spec)\\.[cm]?[jt]sx?$"),
  checks: z
    .array(z.object({ name: z.string(), cmd: z.string() }))
    .default([
      { name: "typecheck", cmd: "npx tsc --noEmit" },
      { name: "lint", cmd: "npx eslint ." },
      { name: "test", cmd: "npx vitest run" },
      { name: "build", cmd: "npx vite build" },
    ]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export const FlowRun = z.object({
  id: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  requirement: z.string(),
  stage: Stage,
  autopilot: z.boolean(),
  /** 單一 run 最多執行幾次 agent */
  maxAgentRuns: z.number().int().positive(),
  /** 暫停前所在的階段與原因（額度用完時） */
  pausedStage: Stage.optional(),
  pauseReason: z.string().optional(),
  /** 這個 run 的 agent 輪替順序（建立時決定，resume 時沿用） */
  cycle: z.array(z.string()).min(1),
  /** 最後一個寫程式的 agent，reviewer 不可以是它 */
  lastWriter: z.string().optional(),
  /** 最後一個要求修改的 reviewer */
  lastReviewer: z.string().optional(),
  /** 最後一個撰寫或修改規格與計畫的 agent */
  planWriter: z.string().optional(),
  /** 最後一個對計畫要求修改的 reviewer */
  planReviewer: z.string().optional(),
  /** 目前的 fix 是因為 verify 失敗還是 review 要求修改 */
  fixSource: z.enum(["verify", "review"]).optional(),
  /** 各關卡的連續失敗次數 */
  attempts: z.record(z.string(), z.number()),
  taskIndex: z.number().int().nonnegative(),
  taskPhase: z.enum(["tests", "code"]),
  testsCommit: z.string().optional(),
  /** 目前任務的測試實際由誰撰寫（可能是代打） */
  lastTestsAuthor: z.string().optional(),
  failedStage: Stage.optional(),
  failureReason: z.string().optional(),
  prUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowRun = z.infer<typeof FlowRun>;
