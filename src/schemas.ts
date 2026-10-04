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
  /** confirm＝不進入實作佇列，另存給使用者確認；amend＝後面任務提出修正請求後由引擎插入的修補任務；沒寫視為要實作。舊 tasks.json 沒有此欄位 */
  kind: z.enum(["implement", "confirm", "amend"]).optional(),
  /** amend 任務修補的是哪個已合併的任務 */
  amendOf: z.string().optional(),
});
export type TaskItem = z.infer<typeof TaskItem>;

/** fast 計畫階段 agent 一併回報的事實 .flow/fast-check.json；任何一項為 true 就改走完整流程，由程式裁決而不是 agent */
export const FastCheck = z.strictObject({
  crossModule: z.boolean(),
  publicOrStoredContract: z.boolean(),
  trustBoundary: z.boolean(),
  unresolvedDecision: z.boolean(),
});
export type FastCheck = z.infer<typeof FastCheck>;

/** agent 發現必須改變已合併任務的行為時寫的 .flow/amend-request.json */
export const AmendRequest = z.object({
  target: z.string().regex(/^T-\d+$/, "target 格式必須是 T-<數字>"),
  reason: z.string().trim().min(1, "reason 不可為空"),
  files: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().trim().min(1)).min(1, "至少要寫一條修補後可驗證的條件"),
});
export type AmendRequest = z.infer<typeof AmendRequest>;

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
      /** 程式碼審查的「額外發現」（criterion 不是 AC 編號）必須附上檔案位置或檢查證據；對應驗收條件的項目可以不寫 */
      evidence: z.string().default(""),
    }),
  ),
});

export type ReviewResult = z.infer<typeof ReviewResult>;

export const DivergeFrame = z.enum(["acceptance", "split", "invert"]);
export type DivergeFrame = z.infer<typeof DivergeFrame>;

export const DivergeBranch = z.object({
  frame: DivergeFrame,
  hypothesis: z.string().trim().min(1),
  nextStep: z.string().trim().min(1),
});
export type DivergeBranch = z.infer<typeof DivergeBranch>;

export const DivergePick = z.object({
  pick: DivergeFrame,
  action: z.enum(["keep_fixing", "rewrite_tests", "split_task"]),
  rationale: z.string().trim().min(1),
  nextStep: z.string().trim().min(1),
});
export type DivergePick = z.infer<typeof DivergePick>;

export const DivergeRecord = z.object({
  stamp: z.string().min(1),
  status: z.enum(["running", "done", "skipped"]),
  key: z.string().min(1),
  frames: z.array(DivergeFrame),
  branches: z.array(DivergeBranch).default([]),
  pick: DivergePick.optional(),
  reason: z.string().optional(),
  // 發散當下 retries.jsonl 的筆數：之後連續合格只算這之後新增的，同一段失敗不會再觸發第二次
  retriesSeen: z.number().int().min(0).optional(),
});
export type DivergeRecord = z.infer<typeof DivergeRecord>;

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

export const ModelStage = z.enum(["spec", "plan", "planReview", "planFix", "planArbiter", "taskTests", "taskCode", "taskReview", "taskFix", "fix", "review", "diverge"]);
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

/** eslint 不該掃到的目錄：交接檔、run 資料、本機 git worktree */
export const ESLINT_IGNORE_PATTERNS = [".flow/**", ".agentflowctl/**", ".worktree/**", ".worktrees/**"] as const;
export const ESLINT_IGNORE_ARGS = ESLINT_IGNORE_PATTERNS.map((pattern) => `--ignore-pattern '${pattern}'`).join(" ");
/**
 * vitest 的額外排除。CLI 的 --exclude 會附加在專案設定與預設 exclude 之後，
 * 不會蓋掉 node_modules 等既有排除。
 */
export const VITEST_WORKTREE_EXCLUDES = "--exclude '**/.worktree/**' --exclude '**/.worktrees/**'";

/** 目標專案可選的 flow.config.json，預設值是中性的：沒有偵測結果時不安裝、不跑檢查 */
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
      fix: ModelStrength.optional(), review: ModelStrength.optional(), diverge: ModelStrength.optional(),
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
  /** 檢查失敗時先原樣重跑失敗的那幾項一次；第二次通過視為 flaky、放行並留下紀錄，兩次都失敗才叫修正者。false＝一失敗就進修正 */
  rerunFailedChecks: z.boolean().default(true),
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
  /** 同一任務連續因測試／實作關卡失敗時，下一次寫檔前先從 2 到 3 個角度診斷 */
  diverge: z.strictObject({
    enabled: z.boolean().default(true),
    /** 同一 key 最近連續幾筆合格重試時觸發 */
    after: z.number().int().min(1).default(2),
    branches: z.number().int().min(2).max(3).default(3),
  }).default({ enabled: true, after: 2, branches: 3 }),
  /**
   * 仲裁意見分歧時怎麼辦（只有兩家時由雙方各自仲裁，才可能分歧）：
   * proceed＝繼續實作，爭議記錄在計畫裡，後面還有測試、驗證與程式碼審查把關；stop＝停下來等人
   */
  tieBreak: z.enum(["proceed", "stop"]).default("proceed"),
  /** 計畫定案前，單一 run 最多執行幾次 agent */
  maxAgentRuns: z.number().int().positive().default(60),
  /** 計畫定案後，上限改為「已執行次數 + 任務數 × 這個值」；run／resume 明確指定 --max-agent-runs 時不改算 */
  agentRunsPerTask: z.number().int().positive().default(20),
  /** 同一個已合併任務最多被後面的任務要求修補幾次；超過就暫停等人處理 */
  maxAmendments: z.number().int().min(1).default(2),
  /** 同一個任務「審查或驗證未通過 → 修正」最多來回幾圈，超過就暫停等人；各關另有 maxAttempts */
  maxTaskRounds: z.number().int().min(1).default(3),
  /** 同一關連續失敗幾次後停止；至少 3，修正與審查才來得及往返一輪 */
  maxAttempts: z.number().int().min(3).default(5),
  /** 終端機是否印出 agent 的文字、工具呼叫與專案指令；命令列 -v 也能開啟 */
  verbose: z.boolean().default(false),
  /** 沒有偵測結果時不安裝；偵測與手動設定的值一律優先（detect.ts） */
  install: z.string().default("true"),
  test: z.string().default("true"),
  /** 通用的測試檔命名：tests/、__tests__/、test_*、*_test.*、*.test.*、*.spec.*；偵測到生態系統時由偵測結果取代 */
  testPattern: z.string().default(String.raw`(^|/)(tests?|__tests__)/|(^|/)test_[^/]+$|[._-](test|spec)s?\.[^/]+$`),
  checks: z
    .array(z.object({
      name: z.string(),
      cmd: z.string(),
      /** 每個任務的驗證跳過，只在最後整支分支的 verify 才跑 */
      finalOnly: z.boolean().optional(),
      /** 最後 verify 時只檢查整支分支改過的檔案：把檔案清單接在指令後面 */
      changedOnly: z.boolean().optional(),
    }))
    .default([]),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

/** agent 提出的規則：附一行範例，程式用它驗證規則真的比對得到 */
export const PatternProposal = z.object({ pattern: z.string(), example: z.string() });
export const FailureFormat = z.enum(["tap", "pytest", "go", "cargo"]);

/** agent 對未知類型專案提出的指令、以及對任何專案的語言規則補充；尚未經程式驗證 */
export const DetectionProposal = z.object({
  install: z.string().optional(),
  test: z.string().optional(),
  checks: z.array(z.object({ name: z.string(), cmd: z.string(), finalOnly: z.boolean().optional() })).default([]),
  testPattern: z.string().optional(),
  depDirs: z.array(z.string()).optional(),
  skipDirs: z.array(z.string()).optional(),
  sourceExts: z.array(z.string()).optional(),
  skipPatterns: z.array(PatternProposal).optional(),
  suppressPatterns: z.array(PatternProposal).optional(),
  assertPattern: PatternProposal.optional(),
  failureLine: PatternProposal.optional(),
  failureFormat: FailureFormat.optional(),
});
export type DetectionProposal = z.infer<typeof DetectionProposal>;

/** `.agentflowctl/detected.json`：通過驗證的欄位，以及被丟掉的欄位與原因；沒有的欄位代表沒有可用的結果 */
export const DetectedFile = DetectionProposal.omit({ skipPatterns: true, suppressPatterns: true, assertPattern: true, failureLine: true }).extend({
  /** 已驗證的規則字串（不含 example） */
  skipPatterns: z.array(z.string()).optional(),
  suppressPatterns: z.array(z.string()).optional(),
  assertPattern: z.string().optional(),
  failureLine: z.string().optional(),
  fingerprint: z.string(),
  generatedAt: z.string(),
  dropped: z.array(z.object({ field: z.string(), reason: z.string() })).default([]),
});
export type DetectedFile = z.infer<typeof DetectedFile>;

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
  /** --fast：一次 agent 呼叫寫完規格與計畫、略過計畫審查與任務審查；計畫標出複雜度時清掉，改走完整流程（舊 state.json 沒有此欄位） */
  fast: z.boolean().optional(),
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
  /** replan --no-review：計畫修訂完成後直接定案，不再送審 */
  skipPlanReview: z.boolean().optional(),
  /** 目前的 fix 是因為 verify 失敗還是 review 要求修改 */
  fixSource: z.enum(["verify", "review"]).optional(),
  /** 各關卡的連續失敗次數 */
  attempts: z.record(z.string(), z.number()),
  modelMode: z.enum(["balanced", "adaptive"]).optional(),
  modelRetryAttempts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  taskIndex: z.number().int().nonnegative(),
  /** 平行任務模式下已合併回 run 分支的任務 id（舊 state.json 沒有此欄位） */
  doneTasks: z.array(z.string()).optional(),
  /** 各已合併任務被修補過幾次（舊 state.json 沒有此欄位） */
  amendments: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** 平行任務的車道專用：這個任務在整份任務清單裡的位置，讓角色輪替與依序執行時一致 */
  taskOffset: z.number().int().nonnegative().optional(),
  /** 目前任務進行到哪一步：寫測試 → 實作 → 審查 → 驗證，審查或驗證未通過時進入修正 */
  taskPhase: z.enum(["tests", "code", "review", "verify", "fix"]),
  /** 目前任務寫測試前的 commit，任務審查只看這之後的變更 */
  taskBase: z.string().optional(),
  testsCommit: z.string().optional(),
  /** 這個任務因綠燈階段無法讓測試通過、已退回測試階段重寫的次數 */
  testsRedos: z.number().int().optional(),
  /** 目前任務已經「審查或驗證未通過 → 修正」幾圈（超過 maxTaskRounds 暫停） */
  taskRounds: z.number().int().optional(),
  /** 整體審查連續回報同一組未通過驗收條件的次數（達 REVIEW_STALL_PAUSE_AFTER 暫停） */
  reviewStall: z.object({ key: z.string(), count: z.number().int() }).optional(),
  /** 目前任務連續幾次綠燈失敗的是別的任務的測試（達上限暫停） */
  regressions: z.number().int().optional(),
  /** 目前任務的測試實際由誰撰寫（可能是代打） */
  lastTestsAuthor: z.string().optional(),
  failedStage: Stage.optional(),
  failureReason: z.string().optional(),
  /** run 為什麼失敗，供 insights 跨 run 彙總；舊 run 沒有這個欄位 */
  failureCategory: FailureCategory.optional(),
  prUrl: z.string().optional(),
  /** 第幾輪：iterate 在同一個 worktree 開下一輪時加一；沒有此欄位視為第 1 輪（舊 state.json） */
  round: z.number().int().min(2).optional(),
  /** iterate 開下一輪時分支的 HEAD：比對「這一輪沒有任何任務動過」的前一輪測試；舊 run 與第 1 輪沒有 */
  roundBase: z.string().optional(),
  /** 第 2 輪起各輪開始的時間（ISO），依序是第 2、3… 輪；status 用它把用量與重試紀錄分輪顯示。舊 run 沒有 */
  roundStarts: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowRun = z.infer<typeof FlowRun>;
