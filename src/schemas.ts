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

/** 使用者可指定的公開流程停點；內部修正階段不列入。 */
export const StopAfterStage = z.enum(["spec", "plan", "implement", "verify", "review", "pr"]);
export type StopAfterStage = z.infer<typeof StopAfterStage>;

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
  /** 後來又被回報、因內容重複而併進這筆的次數；舊紀錄沒有這個欄位 */
  repeats: z.number().int().positive().optional(),
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
  complexity: z.enum(["low", "medium", "high"]).optional(),
  /** false＝這個任務不適合先寫會失敗的測試（建置流程、設定、文件、純重構、實作前就會通過的特徵化測試等），略過紅燈直接實作；沒寫視為 true。描述寫明不要求紅燈時必須為 false */
  tdd: z.boolean().optional(),
  /** confirm＝不進入實作佇列，另存給使用者確認；沒寫視為要實作。舊 tasks.json 沒有此欄位 */
  kind: z.enum(["implement", "confirm"]).optional(),
});
export type TaskItem = z.infer<typeof TaskItem>;

/** 排好的實作清單與另存的確認清單都可以是空的 */
export const OrderedTaskList = z.array(TaskItem);

/** Agent 在 plan 階段產出的 .flow/tasks.json */
export const TaskList = OrderedTaskList.min(1);

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
export const ModelStrength = z.enum(["low", "medium", "high"]);
export type ModelStrength = z.infer<typeof ModelStrength>;

export const ModelStage = z.enum(["spec", "plan", "planReview", "planFix", "planArbiter", "taskTests", "taskCode", "taskReview", "taskFix", "fix", "review"]);
export type ModelStage = z.infer<typeof ModelStage>;

/** 推理強度（effort）；各 CLI 接受的值不同且變動快，這裡只確保非空，值是否可用交給 CLI 與 config agent model check */
export const Effort = z.string().trim().min(1);

export const ModelEntry = z.object({ name: z.string().trim().min(1), strength: ModelStrength, effort: Effort.optional() });

export const AgentDef = z.object({
  adapter: z.enum(["claude", "codex", "gemini", "command"]),
  model: z.string().optional(),
  /** 沒有指定 effort 的 balanced 呼叫沿用這個；只有 claude 與 codex 支援 */
  effort: Effort.optional(),
  models: z.array(ModelEntry).optional(),
  extraArgs: z.array(z.string()).default([]),
  /** 只有 command adapter 使用，`{prompt}` 會被替換成 prompt */
  command: z.array(z.string()).optional(),
  modelProbe: z.array(z.string()).optional(),
}).superRefine((def, ctx) => {
  if (def.adapter === "claude" || def.adapter === "codex") return;
  if (def.effort !== undefined) ctx.addIssue({ code: "custom", path: ["effort"], message: `${def.adapter} adapter 不支援 effort，只有 claude 與 codex 可以設定` });
  def.models?.forEach((m, i) => {
    if (m.effort !== undefined) ctx.addIssue({ code: "custom", path: ["models", i, "effort"], message: `${def.adapter} adapter 不支援 effort，只有 claude 與 codex 可以設定` });
  });
});
export type AgentDef = z.infer<typeof AgentDef>;

/** 目標專案可選的 flow.config.json，預設值對應 Vite + TypeScript + Vitest 專案 */
export const RepoConfig = z.object({
  /** 可用的 agent；沒有內建，全部都要在這裡定義（通常用 config agent add） */
  agents: z.record(z.string(), AgentDef).default({}),
  /** 各 CLI adapter 的預設模型；agent 自己指定 model 時優先使用個別設定 */
  defaultModels: z.strictObject({
    claude: z.string().trim().min(1).optional(),
    codex: z.string().trim().min(1).optional(),
    gemini: z.string().trim().min(1).optional(),
  }).default({}),
  modelSelection: z.object({
    mode: z.enum(["balanced", "adaptive"]).default("balanced"),
    stageStrength: z.strictObject({
      spec: ModelStrength.optional(), plan: ModelStrength.optional(), planReview: ModelStrength.optional(),
      planFix: ModelStrength.optional(), planArbiter: ModelStrength.optional(), taskTests: ModelStrength.optional(),
      taskCode: ModelStrength.optional(), taskReview: ModelStrength.optional(), taskFix: ModelStrength.optional(),
      fix: ModelStrength.optional(), review: ModelStrength.optional(),
    }).default({}),
  }).default({ mode: "balanced", stageStrength: {} }),
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
  /** 同一輪審查最多幾位審查者同時執行；沒寫＝不限，1＝一次一位 */
  reviewConcurrency: z.number().int().min(1).optional(),
  /** 沒有相依關係的任務最多幾個同時執行（各在自己的 worktree）；沒寫不限，1 為一次一個任務 */
  taskConcurrency: z.number().int().min(1).optional(),
  /** 同一次驗證裡 typecheck、lint、test、build 等檢查最多幾個同時執行；沒寫不限，1 為一次一個 */
  checksConcurrency: z.number().int().min(1).optional(),
  /** 計畫審查僵持不下（達到重試上限或意見不再變化）時，交給第三方 agent 仲裁，而不是停下來等人 */
  planArbiter: z.boolean().default(true),
  /** 任務夠多、能依檔案分群時，計畫審查改成每輪一次索引加上只審有變動的任務群 */
  planReviewLayers: z.strictObject({
    enabled: z.boolean().default(true),
    /** 任務數達到這個值才考慮分層 */
    minTasks: z.number().int().min(2).default(7),
    /** 每輪最多幾群 */
    maxGroups: z.number().int().min(2).default(5),
    /** 群數也不超過任務數除以這個值，避免拆出很多只有一兩個任務的呼叫 */
    tasksPerGroup: z.number().int().min(1).default(3),
  }).default({ enabled: true, minTasks: 7, maxGroups: 5, tasksPerGroup: 3 }),
  /**
   * 仲裁意見分歧時怎麼辦（只有兩家時由雙方各自仲裁，才可能分歧）：
   * proceed＝繼續實作，爭議記錄在計畫裡，後面還有測試、驗證與程式碼審查把關；stop＝停下來等人
   */
  tieBreak: z.enum(["proceed", "stop"]).default("proceed"),
  /** 計畫定案前，單一 run 最多執行幾次 agent */
  maxAgentRuns: z.number().int().positive().default(60),
  /** 計畫定案後，上限改為「已執行次數 + 任務數 × 這個值」；run／resume 明確指定 --max-agent-runs 時不改算 */
  agentRunsPerTask: z.number().int().positive().default(20),
  /** 同一關連續失敗幾次後停止；至少 3，修正與審查才來得及往返一輪 */
  maxAttempts: z.number().int().min(3).default(5),
  /** 終端機是否印出 agent 的文字、工具呼叫與專案指令；命令列 -v 也能開啟 */
  verbose: z.boolean().default(false),
  install: z.string().default("npm install --no-audit --no-fund"),
  test: z.string().default("npx vitest run"),
  testPattern: z.string().default("\\.(test|spec)\\.[cm]?[jt]sx?$"),
  checks: z
    .array(z.object({
      name: z.string(),
      cmd: z.string(),
      /** 每個任務的驗證跳過，只在最後整支分支的 verify 才跑 */
      finalOnly: z.boolean().optional(),
      /** 最後 verify 時只檢查整支分支改過的檔案：把檔案清單接在指令後面 */
      changedOnly: z.boolean().optional(),
    }))
    .default([
      { name: "typecheck", cmd: "npx tsc --noEmit" },
      { name: "lint", cmd: "npx eslint --ignore-pattern '.flow/**' --ignore-pattern '.agentflowctl/**' ." },
      { name: "test", cmd: "npx vitest run" },
      { name: "build", cmd: "npx vite build" },
    ]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

/** 讓 run 進入 failed 的原因：關卡重試達上限以外，還有仲裁停止、PR 前仍有未結事項、agent 次數用完、例外與使用者取消 */
export const FailureCategory = z.enum(["retry_limit", "arbitration_stop", "open_handoff", "agent_budget", "error", "cancelled"]);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const FlowRun = z.object({
  id: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  requirement: z.string(),
  stage: Stage,
  /** 完成這個公開階段後暫停；舊 run 沒有此欄位時一路跑完。 */
  stopAfter: StopAfterStage.optional(),
  autopilot: z.boolean(),
  /** 單一 run 最多執行幾次 agent */
  maxAgentRuns: z.number().int().positive(),
  /** 使用者用 --max-agent-runs 明確指定過上限：計畫定案時不再依任務數改算（舊 state.json 沒有此欄位） */
  maxAgentRunsExplicit: z.boolean().optional(),
  /** 這個 run 同一關連續失敗的上限；沒寫就用 flow.config.json 的 maxAttempts（舊 state.json 沒有此欄位） */
  maxAttempts: z.number().int().min(3).optional(),
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
  modelMode: z.enum(["balanced", "adaptive"]).optional(),
  modelRetryAttempts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  taskIndex: z.number().int().nonnegative(),
  /** 平行任務模式下已合併回 run 分支的任務 id（舊 state.json 沒有此欄位） */
  doneTasks: z.array(z.string()).optional(),
  /** 平行任務的車道專用：這個任務在整份任務清單裡的位置，讓角色輪替與依序執行時一致 */
  taskOffset: z.number().int().nonnegative().optional(),
  /** 目前任務進行到哪一步：寫測試 → 實作 → 審查 → 驗證，審查或驗證未通過時進入修正 */
  taskPhase: z.enum(["tests", "code", "review", "verify", "fix"]),
  /** 目前任務寫測試前的 commit，任務審查只看這之後的變更 */
  taskBase: z.string().optional(),
  testsCommit: z.string().optional(),
  /** 目前任務的測試實際由誰撰寫（可能是代打） */
  lastTestsAuthor: z.string().optional(),
  failedStage: Stage.optional(),
  failureReason: z.string().optional(),
  /** run 為什麼失敗，供 insights 跨 run 彙總；舊 run 沒有這個欄位 */
  failureCategory: FailureCategory.optional(),
  prUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowRun = z.infer<typeof FlowRun>;
