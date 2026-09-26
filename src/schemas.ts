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

export const HandoffSource = z.object({
  stage: Stage,
  step: z.string().min(1),
  agent: z.string().min(1),
  callKey: z.string().min(1),
});
export type HandoffSource = z.infer<typeof HandoffSource>;

const HandoffKind = z.enum(["action", "info"]);
const HandoffTarget = z.enum(["plan", "code"]);
const HandoffStatus = z.enum(["open", "proposed_resolved", "resolved", "accepted"]);

export const HandoffResponse = z.object({
  newIssues: z.array(z.object({
    kind: HandoffKind,
    summary: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    targetStage: HandoffTarget,
  })),
  dispositions: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["proposed_resolved", "resolved", "accepted"]),
    reason: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
  })),
});
export type HandoffResponse = z.infer<typeof HandoffResponse>;

export const HandoffIssue = z.object({
  id: z.string().min(1),
  source: HandoffSource,
  kind: HandoffKind,
  summary: z.string().min(1),
  evidence: z.string().min(1),
  targetStage: HandoffTarget,
  status: HandoffStatus,
  resolution: z.object({
    agent: z.string(),
    reason: z.string(),
    evidence: z.string(),
  }).optional(),
  updatedAt: z.string(),
});
export type HandoffIssue = z.infer<typeof HandoffIssue>;

export const HandoffLedger = z.object({
  version: z.literal(1),
  issues: z.array(HandoffIssue),
  /** 用來辨識沒有新增事項的回覆是否已經合併。 */
  appliedCalls: z.array(z.string()).optional(),
});
export type HandoffLedger = z.infer<typeof HandoffLedger>;

/** Agent 在 spec 階段產出的 .flow/acceptance.json */
export const AcceptanceList = z
  .array(
    z.object({
      id: z.string().regex(/^AC-\d+$/, "id 格式必須是 AC-<數字>"),
      description: z.string().min(1),
    }),
  )
  .min(1);
export type AcceptanceItem = z.infer<typeof AcceptanceList>[number];

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

/** 計畫與程式碼審查的結果：verdict 必須和 items 一致，否則視為格式錯誤重試 */
export const ConsistentReviewResult = ReviewResult.superRefine((review, ctx) => {
  const unmet = review.items.filter((i) => i.status !== "met");
  if (review.verdict === "approve" && unmet.length)
    ctx.addIssue({ code: "custom", message: `verdict 為 approve，但 items 仍有未通過的項目：${unmet.map((i) => i.criterion).join("、")}` });
  if (review.verdict === "changes_requested" && !unmet.length)
    ctx.addIssue({ code: "custom", message: "verdict 為 changes_requested，但 items 沒有列出任何未通過的項目" });
});

/** 仲裁者可能用 reject 表示否決；讀取時正規化，保留相同的理由欄位。 */
export const ArbiterResult = ReviewResult.extend({
  verdict: z.enum(["approve", "changes_requested", "reject"])
    .transform((verdict) => verdict === "reject" ? "changes_requested" as const : verdict),
});

/** 一個 agent 的定義；名稱（agents 的 key）用在 cycle 裡 */
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
  /** 可用的 agent；沒有內建，全部都要在這裡定義（通常用 agent add） */
  agents: z.record(z.string(), AgentDef).default({}),
  /** 各 CLI adapter 的預設模型；agent 自己指定 model 時優先使用個別設定 */
  defaultModels: z.strictObject({
    claude: z.string().trim().min(1).optional(),
    codex: z.string().trim().min(1).optional(),
    gemini: z.string().trim().min(1).optional(),
  }).default({}),
  /** 參與的 agent（順序不影響分工）；未設定時取 agents 裡已安裝的 CLI */
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
  /** 這個 run 參與的 agent（建立時決定，resume 時沿用） */
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
  /** 目前任務進行到哪一步：寫測試 → 實作 → 審查 → 驗證，審查或驗證未通過時進入修正 */
  taskPhase: z.enum(["tests", "code", "review", "verify", "fix"]),
  /** 目前任務寫測試前的 commit，任務審查只看這之後的變更 */
  taskBase: z.string().optional(),
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
