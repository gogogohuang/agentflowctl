import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { arbitrationDecision } from "./arbitration.js";
import { detectProjectDefaults, usesTestFramework, withProjectDefaults } from "./detect.js";
import { escapeXml, opinion, reviewIssue } from "./feedback.js";
import { changedFiles, commitAll, discardChanges, git, headCommit, resetTo } from "./git.js";
import { acceptHandoff, openActions, prepareHandoff, previewHandoff, readHandoff, recoverHandoff, responsePath, reviewHandoffGate, validateHandoffResponse } from "./handoff.js";
import { flowDir, logDir, planArbitrationPath, planReviewStatePath, projectRoot, runDir, worktreeDir } from "./paths.js";
import { CMD_AGENT, nextLogFile, redStepName } from "./logs.js";
import { exec } from "./proc.js";
import { arbiterPanel, availableAgent, fixAgent, planAgent, planFixAgent, reviewers, specAgent, taskAgents } from "./roles.js";
import { dropCall, loadCalls, openRound, runPool, saveCall, storedCallValid, type StoredCall } from "./parallelReview.js";
import { cleanupTempWorktrees, withTempWorktree, type Workspace } from "./tempWorktree.js";
import { resolveAgent, runAgent, runCommand, type AgentResult, type AgentTarget } from "./runner.js";
import {
  AcceptanceList,
  type AcceptanceItem,
  ArbiterResult,
  ConsistentReviewResult,
  RepoConfig,
  OrderedTaskList,
  TaskItem,
  TaskList,
  type FlowRun,
  type HandoffLedger,
  type Stage,
} from "./schemas.js";
import { addRetry, addSubstitution, addUsage, agentRuns, saveRun, type RetryCategory } from "./store.js";
import { clearModelReviewFailure, clearModelReviewStage, recordModelReviewFailure, selectModel } from "./modelSelection.js";
import {
  applyReviewVerdicts,
  dirtyGroups,
  dirtyTaskIds,
  extractPlanEvidence,
  groupReviewerCount,
  layeredReview,
  neighborTasks,
  planContentKey,
  planOverview,
  planReviewIndex,
  readPendingArbitration,
  readPlanReviewState,
  repliesForTasks,
  reviewFingerprint,
  roundProgress,
  type PendingArbitration,
  type PlanReviewCall,
  type PlanReviewGroup,
  type PlanReviewRound,
  type PlanReviewState,
} from "./planReview.js";
import { descriptionWaivesRed, orderTasks, outOfScopeFiles, outOfScopeMessage, taskAcceptance, validateTaskComplexity, validateTddFlag } from "./tasks.js";
import { readJsonFile, renderPrompt, tail } from "./util.js";

// ───────────────────────── 共用工具 ─────────────────────────

const info = (run: FlowRun, msg: string) => console.log(`[${run.id}] ${msg}`);
const logHint = (run: FlowRun, seq: number) => `（agentflowctl logs ${run.id} ${seq}）`;
const flowFile = (run: FlowRun, name: string) => join(flowDir(run.id), name);
const to = (run: FlowRun, stage: Stage): FlowRun => ({ ...run, stage });

function target(run: FlowRun, step: string, agent: string, cwd = worktreeDir(run.id)): AgentTarget {
  return { runId: run.id, cwd, logFile: nextLogFile(logDir(run.id), run.stage, step, agent), stage: run.stage, step };
}

/** 額度用完而必須停下：審查類步驟，或所有 agent 的額度都用完 */
export class QuotaPause extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** 這次執行中已確認額度用完的 agent；程序結束即清空，resume 時會重新嘗試 */
const exhausted = new Set<string>();

/** 只供測試使用：清掉這個程序內記下的額度用完 agent，模擬新啟動的程序 */
export function resetQuotaState(): void {
  exhausted.clear();
}

/**
 * 步驟分兩類：
 * - review：計畫審查、程式碼審查、仲裁。額度用完就停下，不由另一家代打，
 *   否則可能變成作者審查自己，失去交叉審查的意義。
 * - write：規格、計畫、修改計畫、寫測試、寫實作、修正。額度用完時由另一家代打。
 * reset 負責在換人或停下前，清掉額度用完的 agent 留下的半成品。
 */
interface StepMode {
  kind: "review" | "write";
  reset?: () => Promise<void> | void;
  /** 額度用完時不找代打，直接暫停；補寫交接這類必須由原 agent 做的小呼叫使用 */
  pinned?: boolean;
  slot?: number;
  blind?: boolean;
  /** 在這個臨時 workspace 執行：agent 的 cwd 與交接檔都用它，不碰共用的 worktree；審查類額度用完不會在這裡重試，reset 是空操作 */
  workspace?: Workspace;
  /** 平行時加在終端機訊息前面，分辨是哪位審查者 */
  tag?: string;
  /** 審查失敗升級計數的範圍（任務群 id），讓一群的失敗不影響其他群選模 */
  modelScope?: string;
}

interface StepOutcome { r: AgentResult; agent: string; step: string; callKey: string }

function handoffTarget(run: FlowRun): "plan" | "code" {
  return ["spec", "plan", "plan_review", "plan_fix"].includes(run.stage) ? "plan" : "code";
}

/**
 * 每次執行 agent 都用新的 key。重試次數會在後面的輪次重複出現，只靠它組 key 會撞到先前已套用的呼叫，
 * 讓這次的處置被當成重播而略過，所以加上這個 run 已執行 agent 的次數。
 */
function handoffKey(run: FlowRun, step: string, slot: number, agent: string): string {
  const attempts = Object.entries(run.attempts).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([run.id, run.stage, step, run.taskIndex, run.taskPhase, attempts, slot, agent, agentRuns(run.id)]);
}

async function agentStep(
  run: FlowRun,
  planned: string,
  step: string,
  prompt: string,
  mode: StepMode,
): Promise<StepOutcome> {
  const cfg = loadRepoConfig();
  const say = (msg: string) => info(run, mode.tag ? `[${mode.tag}] ${msg}` : msg);
  const reset = mode.reset ?? (mode.workspace ? () => {} : () => discardChanges(worktreeDir(run.id)));
  let agent = planned;
  for (;;) {
    if (exhausted.has(agent)) {
      if (mode.kind === "review" || mode.pinned) {
        throw new QuotaPause(`${agent} 的額度已用完；${step} ${mode.pinned ? "不由另一家代打" : "是審查步驟，不由另一家代打"}`);
      }
      const sub = availableAgent(run.cycle, agent, [...exhausted], `${run.id}:${step}:sub`);
      if (!sub) throw new QuotaPause(`所有 agent 的額度都已用完（${[...exhausted].join("、")}）`);
      const note = step.endsWith("-code") && sub === run.lastTestsAuthor ? "測試與實作由同一家負責" : undefined;
      addSubstitution(run.id, { step, planned, actual: sub, note });
      say(`🔁 ${agent} 額度已用完，${step} 由 ${sub} 代打${note ? `（注意：${note}）` : ""}`);
      agent = sub;
    }
    const selected = selectModel(run, cfg, agent, step,
      /^T-\d+-/.test(step) ? loadOrderedTasks(run)[run.taskIndex]?.complexity : undefined,
      mode.kind === "review" ? agent : undefined, mode.modelScope);
    say(`🤖 ${step}：${agent} 使用 ${selected.name ?? "CLI 預設（名稱未知）"}${selected.insufficient ? `（低於目標 ${selected.targetStrength}）` : ""}`);
    const callKey = handoffKey(run, step, mode.slot ?? 0, agent);
    prepareHandoff(run.id, callKey, handoffTarget(run), mode.blind ?? false, mode.workspace?.flow);
    const r = await runAgent(agent, { ...resolveAgent(cfg, agent), model: selected.name },
      { ...target(run, step, agent, mode.workspace?.dir), strength: selected.strength, targetStrength: selected.targetStrength }, prompt);
    if (r.resolvedModel && r.resolvedModel !== selected.name) say(`   ↳ CLI 回報實際模型：${r.resolvedModel}`);
    addUsage(run.id, { stage: step, agent, model: selected.name, resolvedModel: r.resolvedModel,
      strength: selected.strength, targetStrength: selected.targetStrength, usageReported: r.usageReported,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens });
    if (!r.quotaExhausted) {
      reportMeta(run, agent, r);
      return { r, agent, step, callKey };
    }
    say(`⛽ ${agent} 的額度已用完`);
    exhausted.add(agent);
    await reset();
    // 迴圈回到開頭：review 會停下，write 會找代打
  }
}

/** 原有關卡已通過後才接受交接；失敗回覆不進入正式紀錄。 */
function finishHandoff(
  run: FlowRun, outcome: StepOutcome, role: "writer" | "reviewer",
  gate?: { target: "plan" | "code"; verdict: "approve" | "changes_requested" },
  /** 平行審查：關卡以這個呼叫啟動時看到的帳本判斷（存檔裡的 base），套用仍落在目前的帳本 */
  base?: HandoffLedger,
): string | undefined {
  const parsed = validateHandoffResponse(run.id);
  if (!parsed.ok) return parsed.error;
  try {
    const source = {
      stage: run.stage, step: outcome.step, agent: outcome.agent, callKey: outcome.callKey,
    };
    const preview = previewHandoff(base ?? readHandoff(run.id), outcome.callKey, source, parsed.data, role);
    if (gate) {
      const error = reviewHandoffGate(preview, gate.target, gate.verdict);
      if (error) return error;
    }
    acceptHandoff(run.id, outcome.callKey, source, parsed.data, role);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * 寫作步驟的交接：關卡已通過，交接回覆不合格時不丟掉工作，請同一家 agent 只補寫一次。
 * 補寫前記下 HEAD 與 files 的內容，補寫後一律 reset 回去並還原這些檔案，連補寫自行建立的 commit 也丟棄，
 * 所以補寫無法改變已通過的關卡。補寫仍失敗（或額度用完）就回傳錯誤，由呼叫端照舊還原並重試。
 * base 是這一步開始前的 commit；沒有 commit 的步驟（規格、計畫）省略，補寫者會被告知範圍為空。
 */
async function settleHandoff(
  run: FlowRun, outcome: StepOutcome, files: readonly string[], base?: string,
): Promise<string | undefined> {
  const first = finishHandoff(run, outcome, "writer");
  if (!first) return undefined;
  const repo = worktreeDir(run.id);
  const settled = await headCommit(repo);
  const snap = snapshotPlan(run, files);
  const cleanup = async () => { await resetTo(repo, settled); restorePlan(run, snap); };
  info(run, `📎 交接回覆不合格，請 ${outcome.agent} 只補寫交接（不重做工作）：${first}`);
  let repair: StepOutcome;
  try {
    // pinned 不找代打，額度用完直接暫停，所以不需要 reset；善後一律交給 finally
    repair = await agentStep(
      run, outcome.agent, outcome.step,
      renderPrompt("handoff-repair", { step: outcome.step, error: first, range: `${base ?? settled}..${settled}` }),
      { kind: "write", pinned: true, reset: () => {} },
    );
  } catch (error) {
    if (error instanceof QuotaPause) return first;
    throw error;
  } finally {
    await cleanup();
  }
  if (!repair.r.ok) return `${first}（補寫交接時 Agent 執行失敗：${repair.r.summary}）`;
  return finishHandoff(run, repair, "writer");
}

/** 印出回覆裡的 XML 中繼資料；只供人檢視，關卡仍由程式檢查決定 */
function reportMeta(run: FlowRun, agent: string, r: AgentResult): void {
  if (!r.meta) return;
  if (r.meta.status === "blocked") info(run, `   🚧 ${agent} 回報卡住：${r.meta.summary}`);
  if (r.meta.concerns) info(run, `   💭 ${agent} 的疑慮：${r.meta.concerns}`);
}

/** 讀 .flow/ 下的文字檔，沒有檔就當空字串 */
function flowText(run: FlowRun, name: string): string {
  const p = flowFile(run, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function readFeedback(run: FlowRun): string {
  return flowText(run, "feedback.md");
}

/** 計畫審查第幾輪仍有人要求修改時交付仲裁；固定值，不受重試上限影響 */
const PLAN_ARBITRATION_ROUND = 2;

/** 這個 run 的重試上限：`--max-attempts` 存在 run 裡，沒設定才用 flow.config.json 的 maxAttempts */
function attemptLimit(run: FlowRun): number {
  return run.maxAttempts ?? loadRepoConfig().maxAttempts;
}

/** 關卡未通過：寫入 feedback.md 給下一次嘗試參考，並把原因分類記進 retries.jsonl；超過上限就讓整個 run 失敗 */
function retry(run: FlowRun, key: string, reason: string, backTo: Stage, category: RetryCategory): FlowRun {
  const n = (run.attempts[key] ?? 0) + 1;
  const attempts = { ...run.attempts, [key]: n };
  const final = n >= attemptLimit(run);
  mkdirSync(flowDir(run.id), { recursive: true });
  writeFileSync(flowFile(run, "feedback.md"), `# 前次嘗試未通過（第 ${n} 次）\n\n${reason}\n`);
  addRetry(run.id, { key, backTo, category, attempt: n, final }, run.updatedAt);
  if (final) {
    return { ...run, attempts, stage: "failed", failedStage: backTo, failureCategory: "retry_limit", failureReason: `${key} 連續失敗 ${n} 次：${tail(reason, 500)}` };
  }
  info(run, `⚠️  ${key} 未通過，重試（${n}/${attemptLimit(run)}）`);
  return { ...run, attempts, stage: backTo };
}

function succeed(run: FlowRun, key: string, next: Stage): FlowRun {
  rmSync(flowFile(run, "feedback.md"), { force: true });
  const attempts = { ...run.attempts };
  delete attempts[key];
  return { ...run, attempts, stage: next };
}

/** 回傳這次 transition 完成的公開階段；內部審查／修正 transition 不算交付邊界。 */
function completedStopStage(current: Stage, next: Stage): "spec" | "plan" | "implement" | "verify" | "review" | undefined {
  if (current === "spec" && next === "plan") return "spec";
  if (current === "plan_review" && next === "implement") return "plan";
  if (current === "implement" && next === "verify") return "implement";
  if (current === "verify" && next === "review") return "verify";
  if (current === "review" && next === "pr") return "review";
  return undefined;
}

function pauseAtStopAfter(run: FlowRun, next: FlowRun): FlowRun {
  const completed = completedStopStage(run.stage, next.stage);
  if (!completed || run.stopAfter !== completed) return next;
  return {
    ...next,
    stage: "paused",
    pausedStage: next.stage,
    pauseReason: `已完成指定階段 ${completed}，等待使用者執行 resume 接續`,
  };
}

/** 設定檔放在主專案根目錄，未 commit 的修改也會生效 */
/** 讀取 flow.config.json；沒寫的 install、test、checks 依專案現況偵測 */
export function loadRepoConfig(): RepoConfig {
  const root = projectRoot();
  const detected = detectProjectDefaults(root);
  const p = join(root, "flow.config.json");
  if (!existsSync(p)) return RepoConfig.parse(withProjectDefaults({}, detected));
  const r = readJsonFile(p, z.preprocess((raw) => withProjectDefaults(raw, detected), RepoConfig));
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** 專案有測試框架（偵測到或手動設定 test） */
function hasTestFramework(): boolean {
  const root = projectRoot();
  const p = join(root, "flow.config.json");
  const r = existsSync(p) ? readJsonFile(p, z.unknown()) : undefined;
  return usesTestFramework(r?.ok ? r.data : {}, detectProjectDefaults(root));
}

/** 這個任務要不要走紅綠燈：沒有測試框架一律不走，其餘依 planner 標記（沒標視為要走） */
function taskUsesTdd(task: TaskItem, framework: boolean): boolean {
  return framework && task.tdd !== false;
}

/** 紅燈測試一開始就通過時寫進 feedback.md 的原因；下一次嘗試靠它判斷上一次是不是同樣原因被退回 */
const TESTS_NOT_RED_REASON = "測試在功能尚未實作前就全部通過，代表測試沒有驗證到新行為。請撰寫會因功能尚未實作而失敗的測試。";
/** 越界檢查只擋前兩次：任務描述的路徑只是啟發式，之後交給審查把關，避免誤判讓 run 卡死 */
const SCOPE_GUARD_ATTEMPTS = 2;
const TESTS_NOT_RED_MARK = "請撰寫會因功能尚未實作而失敗的測試";

/** 已定案的任務寫明不要求紅燈：仍寫測試，但通過也算完成紅燈階段。 */
function testsRedGuidance(testCmd: string, waiveRed: boolean): { roleGoal: string; redGuidance: string; verifyNote: string } {
  if (!waiveRed) {
    return {
      roleGoal: "你的測試要精準描述任務要新增的行為，並且在功能實作前確實失敗；之後會由另一位工程師實作到通過，而且對方不能修改你的測試。",
      redGuidance: [
        "3. 測試必須驗證這個任務要新增的行為，並且因為功能尚未實作而**失敗**。",
        `4. 可以先執行本任務相關的測試，確認失敗原因是斷言或找不到尚未實作的模組，而不是語法錯誤或測試本身寫錯。外部流程會再執行 \`${testCmd}\` 驗證紅燈，不需要自行重跑全套測試。`,
      ].join("\n"),
      verifyNote: "驗證測試是否失敗",
    };
  }
  return {
    roleGoal: "這個任務不要求紅燈。請直接寫出鎖定既有行為的測試；測試一開始就通過是預期結果，不要停下來，也不要為了製造失敗而改產品程式。",
    redGuidance: [
      "3. 這個任務的描述已寫明不要求紅燈。請寫出鎖定既有行為的測試；測試一開始就通過是預期結果，不要為了製造失敗而改產品程式，也不要停下來不寫。",
      `4. 可以先執行本任務相關的測試，確認它們能跑完。外部流程會再執行 \`${testCmd}\`，通過即可，不需要自行重跑全套測試。`,
    ].join("\n"),
    verifyNote: "確認測試能跑完。這個任務不要求測試失敗",
  };
}

function loadOrderedTasks(run: FlowRun): TaskItem[] {
  const r = readJsonFile(flowFile(run, "tasks.ordered.json"), OrderedTaskList);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function loadConfirmations(run: FlowRun): TaskItem[] {
  if (!existsSync(flowFile(run, "confirmations.json"))) return [];
  const r = readJsonFile(flowFile(run, "confirmations.json"), OrderedTaskList);
  return r.ok ? r.data : [];
}

function rememberConfirmation(run: FlowRun, task: TaskItem): void {
  const current = loadConfirmations(run);
  if (current.some((item) => item.id === task.id)) return;
  writeFileSync(flowFile(run, "confirmations.json"), JSON.stringify([...current, task], null, 2));
}

function announceConfirmations(run: FlowRun): void {
  const confirm = loadConfirmations(run);
  if (!confirm.length) return;
  info(run, `👀 另有 ${confirm.length} 項需要你確認（不進實作，不會停下）：${confirm.map((t) => `${t.id} ${t.title}`).join("、")}`);
  info(run, `   清單：${flowFile(run, "confirmations.json")}`);
}

// ───────────────────────── 各階段 ─────────────────────────

async function specStage(run: FlowRun): Promise<FlowRun> {
  const agent = specAgent(run.cycle, run.id);
  info(run, `📝 產生規格（${agent}）`);
  const outcome = await agentStep(run, agent, "spec", renderPrompt("spec", { requirement: run.requirement }), { kind: "write" });
  const { r } = outcome;
  await discardChanges(worktreeDir(run.id)); // 這個階段只允許寫 .flow/
  if (!r.ok) return retry(run, "spec", `Agent 執行失敗：${r.summary}`, "spec", "agent_error");
  if (!existsSync(flowFile(run, "spec.md"))) return retry(run, "spec", "缺少 .flow/spec.md", "spec", "missing_artifact");
  const ac = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!ac.ok) return retry(run, "spec", ac.error, "spec", "format_invalid");
  const ids = ac.data.map((a) => a.id);
  if (new Set(ids).size !== ids.length) return retry(run, "spec", "驗收條件 id 有重複", "spec", "format_invalid");
  const handoffError = await settleHandoff(run, outcome, PLAN_FILES);
  if (handoffError) return retry(run, "spec", handoffError, "spec", "handoff_invalid");
  return succeed(run, "spec", "plan");
}

// ── 規格與計畫檔案：計畫審查、仲裁與計畫定案後的所有階段只能讀，不能改 ──

const PLAN_FILES = ["spec.md", "acceptance.json", "plan.md", "tasks.json"] as const;
/** 計畫定案後（實作、修正、程式碼審查）另外依賴排好的任務順序，同樣不能被改 */
const LOCKED_FILES = [...PLAN_FILES, "tasks.ordered.json", "confirmations.json"] as const;
/** 審查、修訂與仲裁的快照另外包含審查回應；不要併進 PLAN_FILES，定案後的階段不依賴它 */
const PLAN_REPLY_FILES = [...PLAN_FILES, "plan-replies.md"] as const;

function snapshotPlan(run: FlowRun, files: readonly string[] = PLAN_FILES): Record<string, string | undefined> {
  return Object.fromEntries(
    files.map((f) => [f, existsSync(flowFile(run, f)) ? readFileSync(flowFile(run, f), "utf8") : undefined]),
  );
}

/** 把被動過的計畫檔案還原成快照的內容，回傳被改的檔名 */
function restorePlan(run: FlowRun, snap: Record<string, string | undefined>): string[] {
  const changed: string[] = [];
  for (const f of Object.keys(snap)) {
    const now = existsSync(flowFile(run, f)) ? readFileSync(flowFile(run, f), "utf8") : undefined;
    if (now === snap[f]) continue;
    changed.push(f);
    if (snap[f] === undefined) rmSync(flowFile(run, f), { force: true });
    else writeFileSync(flowFile(run, f), snap[f]!);
  }
  return changed;
}

/** 計畫的確定性關卡：檔案齊全、格式正確、任務 DAG 合法且涵蓋所有驗收條件 */
function validatePlan(run: FlowRun): TaskItem[] | string {
  if (!existsSync(flowFile(run, "spec.md"))) return "缺少 .flow/spec.md";
  if (!existsSync(flowFile(run, "plan.md"))) return "缺少 .flow/plan.md";
  const ac = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!ac.ok) return ac.error;
  const ids = ac.data.map((a) => a.id);
  if (new Set(ids).size !== ids.length) return "驗收條件 id 有重複";
  const tasks = readJsonFile(flowFile(run, "tasks.json"), TaskList);
  if (!tasks.ok) return tasks.error;
  const complexityError = validateTaskComplexity(tasks.data, run.modelMode ?? "balanced");
  if (complexityError) return complexityError;
  const tddError = validateTddFlag(tasks.data);
  if (tddError) return tddError;
  return orderTasks(tasks.data, new Set(ids));
}

function acceptPlan(run: FlowRun, ordered: TaskItem[]): void {
  const confirm = ordered.filter((t) => t.kind === "confirm");
  const implement = ordered.filter((t) => t.kind !== "confirm");
  writeFileSync(flowFile(run, "tasks.ordered.json"), JSON.stringify(implement, null, 2));
  writeFileSync(flowFile(run, "confirmations.json"), JSON.stringify(confirm, null, 2));
}

function announceTasks(run: FlowRun, ordered: TaskItem[]): void {
  const cfg = loadRepoConfig();
  info(run, `📋 共 ${ordered.length} 個任務：${ordered.map((t) => t.id).join(" → ")}`);
  const framework = hasTestFramework();
  ordered.forEach((t, i) => {
    const a = taskAgents(run.cycle, i, cfg.tddSplit, run.id);
    info(run, taskUsesTdd(t, framework)
      ? `   ${t.id} 測試：${a.tests}　實作：${a.code}　審查：${a.review}`
      : `   ${t.id} 略過 TDD　實作：${a.code}　審查：${a.review}`);
  });
}

/** 計畫定案後：預設直接開始實作；--manual-plan 時才停下來等人 */
function planSettled(run: FlowRun, key: string): FlowRun {
  const pending = openActions(readHandoff(run.id), "plan");
  if (pending.length) return retry(run, "plan-handoff", `計畫仍有未結交接事項：${pending.map((item) => item.id).join("、")}`, "plan_fix", "open_handoff");
  const next = run.autopilot ? "implement" : "awaiting_approval";
  const ordered = loadOrderedTasks(run);
  announceTasks(run, ordered);
  announceConfirmations(run);
  if (!run.autopilot) {
    info(run, `✋ 計畫已通過審查，請檢視 ${flowFile(run, "plan.md")}，確認後執行 agentflowctl approve ${run.id}`);
  }
  const settled = succeed(run, key, next);
  const attempts = { ...settled.attempts };
  delete attempts["plan-arbitration"];
  return { ...settled, attempts, taskIndex: 0, taskPhase: "tests" };
}

async function planStage(run: FlowRun): Promise<FlowRun> {
  const agent = planAgent(run.cycle, run.id);
  info(run, `🗺️  拆解任務（${agent}）`);
  const cfg = loadRepoConfig();
  const outcome = await agentStep(run, agent, "plan", renderPrompt("plan", { testPattern: cfg.testPattern }), { kind: "write" });
  const { r, agent: actual } = outcome;
  await discardChanges(worktreeDir(run.id));
  if (!r.ok) return retry(run, "plan", `Agent 執行失敗：${r.summary}`, "plan", "agent_error");
  const ordered = validatePlan(run);
  if (typeof ordered === "string") return retry(run, "plan", ordered, "plan", "format_invalid");
  const handoffError = await settleHandoff(run, outcome, PLAN_FILES);
  if (handoffError) return retry(run, "plan", handoffError, "plan", "handoff_invalid");
  acceptPlan(run, ordered);
  rmSync(flowFile(run, "plan-review-last.txt"), { force: true });
  return { ...succeed(run, "plan", "plan_review"), planWriter: actual };
}

async function planReviewStage(run: FlowRun): Promise<FlowRun> {
  const cfg = loadRepoConfig();
  const pending = pendingArbitration(run, cfg);
  if (pending) {
    info(run, "⚖️  上次仲裁沒有完成，直接回到仲裁（不重跑計畫審查）");
    return arbitratePlan({ ...run, planReviewer: pending.planReviewer });
  }
  const layered = loadLayeredPlan(run, cfg);
  return layered ? planReviewLayered(run, layered, cfg) : planReviewFull(run, cfg);
}

/** 一次審查呼叫的結果；issueLines 只含意見內容、不含審查者名稱，用來偵測僵持 */
type Collected = Pick<PlanReviewCall, "reviewer" | "verdict" | "issueLines">;

interface PlanReviewCallSpec {
  /** 這一輪內唯一的呼叫識別，存檔與沿用用 */
  key: string;
  reviewer: string;
  step: "plan-review" | "plan-review-group";
  prompt: string;
  slot: number;
  /** agent 寫在 .flow/ 的裁決檔名 */
  output: string;
  /** 移到 run 目錄 reviews/ 後的檔名 */
  archive: string;
  /** 核准卻仍有未結的計畫交接事項時判為矛盾 */
  gated: boolean;
  /** 終端機顯示「核准<subject>」 */
  subject: string;
  /** 任務群 id；選模升級計數依群分開 */
  scope?: string;
}

// ───────────────────────── 平行審查 ─────────────────────────

/** 平行階段的一次審查呼叫 */
interface ReviewCall {
  /** 同一輪內唯一；存檔與沿用都靠它 */
  key: string;
  slot: number;
  reviewer: string;
  step: string;
  prompt: string;
  /** agent 寫在 .flow/ 的裁決檔名 */
  output: string;
  /** 任務群 id；選模升級計數依群分開（與 PlanReviewCallSpec.scope 同名，applyPlanReview 也用它） */
  scope?: string;
}

/** ok＝false 代表 agent 執行失敗（不存檔，交給序列收尾走原有的 retry） */
interface Finished { stored: StoredCall; ok: boolean }

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/**
 * 平行階段：每位審查者在自己的臨時 worktree 執行，成功的結果立刻存檔。
 * 這個階段不改 run、不寫交接帳本、不呼叫 retry。
 * - 已有同一輪存檔、且仍有效的呼叫直接沿用（resume）；帳本在它啟動後被本輪以外的呼叫（例如修正者）動過就作廢重跑
 * - 預算（maxAgentRuns）不夠時只啟動預算內的，回傳 undefined，呼叫端應原樣回傳 run，由 advance 判定 agent_budget
 * - 有呼叫額度用完時，其他呼叫照常跑完並存檔，最後才丟 QuotaPause
 */
async function executeReviewCalls(
  run: FlowRun, cfg: RepoConfig, scope: string, fingerprint: string, calls: ReviewCall[],
): Promise<{ dir: string; finished: Finished[] } | undefined> {
  if (calls.length === 0) return { dir: "", finished: [] };
  // openRound、loadCalls 與有效性檢查都要在 runPool 啟動任何呼叫之前（loadCalls 會刪 .tmp）
  const dir = openRound(run.id, scope, fingerprint);
  const saved = loadCalls(dir);
  const live = readHandoff(run.id);
  const round = [...saved.values()];
  for (const [key, stored] of [...saved]) {
    if (storedCallValid(stored, live, round)) continue;
    dropCall(dir, key);
    saved.delete(key);
  }
  let budget = run.maxAgentRuns - agentRuns(run.id);
  // 已有存檔的不花預算；其餘依序佔預算，超出的這次不啟動
  const launch = calls.filter((call) => saved.has(call.key) || budget-- > 0);
  const limit = cfg.reviewConcurrency ?? Infinity;
  const tagged = limit > 1 && launch.filter((call) => !saved.has(call.key)).length > 1;
  // 預算內能跑的照跑並存檔，之後 resume 加大預算就不必重付
  const executed = await runPool(launch, limit, (call) => executeOne(run, dir, saved, call, tagged));
  const quota = executed.find((item): item is { quota: string } => "quota" in item);
  if (quota) throw new QuotaPause(quota.quota);
  if (launch.length < calls.length) return undefined;
  return { dir, finished: executed as Finished[] };
}

async function executeOne(
  run: FlowRun, dir: string, saved: Map<string, StoredCall>, call: ReviewCall, tagged: boolean,
): Promise<Finished | { quota: string }> {
  const reused = saved.get(call.key);
  if (reused) {
    info(run, `   ↪ 沿用本輪已完成的審查（${call.reviewer}）`);
    return { stored: reused, ok: true };
  }
  try {
    return await withTempWorktree(run.id, `slot-${call.slot}`, async (ws) => {
      rmSync(join(ws.flow, call.output), { force: true });
      // 平行階段不動帳本，同一批呼叫看到的都是這一份；序列收尾以它評估這個呼叫的核准門檻
      const base = readHandoff(run.id);
      const outcome = await agentStep(run, call.reviewer, call.step, call.prompt, {
        kind: "review", slot: call.slot, modelScope: call.scope, workspace: ws, tag: tagged ? call.reviewer : undefined,
      });
      const stored: StoredCall = {
        key: call.key, reviewer: call.reviewer, agent: outcome.agent, step: outcome.step, callKey: outcome.callKey,
        summary: outcome.r.summary,
        output: readIfExists(join(ws.flow, call.output)),
        handoffResponse: readIfExists(responsePath(run.id, ws.flow)),
        base,
      };
      if (outcome.r.ok) saveCall(dir, stored); // 先存檔，臨時 worktree 才會被移除
      return { stored, ok: outcome.r.ok };
    });
  } catch (err) {
    if (err instanceof QuotaPause) return { quota: err.message };
    throw err;
  }
}

/** 序列收尾第一步：把存檔的內容放回共用 .flow/，之後就能沿用原有的驗證與交接程式 */
function replay(run: FlowRun, stored: StoredCall, output: string): void {
  mkdirSync(flowDir(run.id), { recursive: true });
  const put = (path: string, text: string | null) => (text === null ? rmSync(path, { force: true }) : writeFileSync(path, text));
  put(flowFile(run, output), stored.output);
  put(responsePath(run.id), stored.handoffResponse);
}

/** 存檔內容還原成 finishHandoff 需要的 StepOutcome */
function storedOutcome(stored: StoredCall, ok: boolean): StepOutcome {
  return {
    r: { ok, quotaExhausted: false, summary: stored.summary, usageReported: false },
    agent: stored.agent, step: stored.step, callKey: stored.callKey,
  };
}

/**
 * 整份審查與分層審查共用的序列收尾：驗證裁決與交接。
 * 失敗時回傳已呼叫 retry 的 run、沒有 collected，呼叫端應直接回傳這個 run；
 * 不合格的存檔結果一併刪掉，否則同一輪重跑會反覆讀到同一份。
 */
function applyPlanReview(
  run: FlowRun, spec: PlanReviewCallSpec, done: Finished, dir: string,
): { run: FlowRun; collected?: Collected } {
  const { reviewer, step } = spec;
  const stop = (category: RetryCategory, reason: string) => {
    dropCall(dir, spec.key);
    return { run: retry(recordModelReviewFailure(run, step, reviewer, spec.scope), "plan-review-run", reason, "plan_review", category) };
  };
  if (!done.ok) return stop("agent_error", `Agent 執行失敗：${done.stored.summary}`);
  replay(run, done.stored, spec.output);
  const review = readJsonFile(flowFile(run, spec.output), ConsistentReviewResult);
  if (!review.ok) return stop("format_invalid", review.error);
  // 群審查不帶關卡：索引要求修改並新增事項後，群的核准不算矛盾；最後由 planSettled 檢查未結事項。
  // 門檻以這個呼叫自己看到的帳本評估：同輪其他審查者剛新增（或崩潰前已套用）的事項它沒看過，不能拿來判它矛盾
  const handoffError = finishHandoff(run, storedOutcome(done.stored, true), "reviewer", spec.gated ? { target: "plan", verdict: review.data.verdict } : undefined, done.stored.base);
  if (handoffError) return stop("handoff_invalid", handoffError);
  run = clearModelReviewFailure(run, step, reviewer, spec.scope);
  // 審查紀錄移到 worktree 外面：之後的仲裁者看不到是哪一家提的意見
  mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
  writeFileSync(join(runDir(run.id), "reviews", spec.archive), readFileSync(flowFile(run, spec.output)));
  rmSync(flowFile(run, spec.output), { force: true });
  if (review.data.verdict === "approve") {
    info(run, `   ✓ ${reviewer} 核准${spec.subject}`);
    return { run, collected: { reviewer, verdict: "approve", issueLines: [] } };
  }
  info(run, `   ✗ ${reviewer} 要求修改${spec.subject}`);
  const issueLines = review.data.items
    .filter((i) => i.status !== "met")
    .map((i) => reviewIssue(i.criterion, i.status, i.note));
  return { run, collected: { reviewer, verdict: "changes_requested", issueLines } };
}

/** 一輪審查都產出合法裁決後：全部核准就定案，否則退回修訂，僵持或達輪數上限時交付仲裁 */
async function concludePlanReview(run: FlowRun, cfg: RepoConfig, round: number, calls: Collected[]): Promise<FlowRun> {
  const objections = calls.filter((call) => call.verdict !== "approve");
  const issueLines = objections.flatMap((call) => call.issueLines);
  const issues = objections.map((call) => opinion(call.reviewer, call.issueLines));
  const firstObjector = objections[0]?.reviewer;
  run = clearModelReviewStage(run, "plan-review");
  const attempts = { ...run.attempts };
  delete attempts["plan-review-run"];
  run = { ...run, attempts };
  if (!firstObjector) return planSettled(run, "plan-review");

  const report = `計畫審查要求修改：\n\n${issues.join("\n\n")}`;
  // 僵持偵測：意見和上一輪完全相同，代表修改沒有進展
  const lastPath = flowFile(run, "plan-review-last.txt");
  const fingerprint = reviewFingerprint(issueLines);
  const stalled = existsSync(lastPath) && readFileSync(lastPath, "utf8") === fingerprint;
  writeFileSync(lastPath, fingerprint);
  // 修訂過一次仍被要求修改就交付仲裁，不等到重試上限
  const exhausted = round >= PLAN_ARBITRATION_ROUND;
  if ((stalled || exhausted) && cfg.planArbiter) {
    // 雙盲：帶有審查者名稱的 feedback.md 不留在 worktree，完整報告另存到 worktree 外
    rmSync(flowFile(run, "feedback.md"), { force: true });
    mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
    writeFileSync(join(runDir(run.id), "reviews", "dispute-full.md"), report);
    // 給仲裁者的爭議清單不含任何模型名稱
    writeFileSync(flowFile(run, "dispute.md"), `# 尚未解決的審查意見\n\n${[...new Set(issueLines)].join("\n")}\n`);
    info(run, `⚖️  計畫審查${stalled ? "意見沒有變化" : `已達 ${round} 輪`}，交付仲裁`);
    // 仲裁暫停（裁決無效或額度用完）後 resume 仍停在 plan_review，靠這份紀錄直接回到仲裁
    mkdirSync(runDir(run.id), { recursive: true });
    writeFileSync(planArbitrationPath(run.id), JSON.stringify({ planReviewer: firstObjector, planKey: currentPlanKey(run) }, null, 2));
    return arbitratePlan({ ...run, planReviewer: firstObjector });
  }
  return { ...retry(run, "plan-review", report, "plan_fix", "review_changes"), planReviewer: firstObjector };
}

/** 整份審查：每位審查者讀完整份規格與計畫 */
async function planReviewFull(run: FlowRun, cfg: RepoConfig): Promise<FlowRun> {
  // 整份審查不維護分層狀態；之後若又切回分層，不能沿用這之前的 approve
  rmSync(planReviewStatePath(run.id), { force: true });
  const author = run.planWriter ?? planAgent(run.cycle, run.id);
  const round = (run.attempts["plan-review"] ?? 0) + 1;
  const panel = reviewers(run.cycle, author, cfg.planReviewQuorum, `${run.id}:plan-review:${round}`);

  const specs: PlanReviewCallSpec[] = panel.map((reviewer, slot) => ({
    key: `full:${reviewer}`, reviewer, step: "plan-review", slot, gated: true, subject: "計畫",
    prompt: renderPrompt("plan-review", { reviewer, author, requirement: run.requirement }),
    output: "plan-review.json", archive: `plan-review-${round}-${reviewer}.json`,
  }));
  for (const spec of specs) info(run, `🧐 計畫審查第 ${round} 輪（${spec.reviewer}，作者 ${author}）`);
  const ran = await executeReviewCalls(run, cfg, "plan-review", `${round}:${currentPlanKey(run)}`, specs);
  if (!ran) return run;

  const calls: Collected[] = [];
  for (const [i, spec] of specs.entries()) {
    const passed = applyPlanReview(run, spec, ran.finished[i]!, ran.dir);
    run = passed.run;
    if (!passed.collected) return run;
    calls.push(passed.collected);
  }
  return concludePlanReview(run, cfg, round, calls);
}

/** 本輪進度的雜湊涵蓋的檔案：任一份變了，就不能沿用先前的審查結果 */
const PLAN_KEY_FILES = ["tasks.json", "acceptance.json", "plan.md", "plan-replies.md"] as const;

function currentPlanKey(run: FlowRun): string {
  return planContentKey(PLAN_KEY_FILES.map((name) => flowText(run, name)));
}

/**
 * 上次交付仲裁卻沒有得出裁決（暫停）時的紀錄。計畫在這之間被改過、或爭議清單不見了，
 * 就當成沒有待完成的仲裁並刪掉紀錄，重新審查。暫停期間關掉了 planArbiter 也一樣，
 * 連同爭議清單一起刪掉。
 */
function pendingArbitration(run: FlowRun, cfg: RepoConfig): PendingArbitration | undefined {
  const path = planArbitrationPath(run.id);
  if (!existsSync(path)) return undefined;
  const pending = readPendingArbitration(readFileSync(path, "utf8"));
  if (cfg.planArbiter && pending && pending.planKey === currentPlanKey(run) && existsSync(flowFile(run, "dispute.md"))) return pending;
  rmSync(path, { force: true });
  if (!cfg.planArbiter) rmSync(flowFile(run, "dispute.md"), { force: true });
  return undefined;
}

interface LayeredPlan {
  tasks: TaskItem[];
  acceptance: AcceptanceItem[];
  planMd: string;
  dirty: PlanReviewGroup[];
  state: PlanReviewState | undefined;
}

/** 符合分層條件時讀出分層審查需要的資料；不符合時回傳 undefined，已達門檻的會印出原因 */
function loadLayeredPlan(run: FlowRun, cfg: RepoConfig): LayeredPlan | undefined {
  const tasks = readJsonFile(flowFile(run, "tasks.json"), TaskList);
  const acceptance = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!tasks.ok || !acceptance.ok) return undefined;
  const planMd = flowText(run, "plan.md");
  const decision = layeredReview(tasks.data, planMd, cfg.planReviewLayers);
  if (!decision.layered) {
    if (decision.reason) info(run, `📋 這次計畫審查讀整份計畫：${decision.reason}`);
    return undefined;
  }
  const statePath = planReviewStatePath(run.id);
  const state = existsSync(statePath) ? readPlanReviewState(readFileSync(statePath, "utf8")) : undefined;
  return {
    tasks: tasks.data, acceptance: acceptance.data, planMd, state,
    dirty: dirtyGroups(decision.groups, dirtyTaskIds(state?.reviewed, tasks.data, acceptance.data, planMd)),
  };
}

/** 分層審查：每輪一次索引審查，再只審有變動的任務群 */
async function planReviewLayered(run: FlowRun, layered: LayeredPlan, cfg: RepoConfig): Promise<FlowRun> {
  const author = run.planWriter ?? planAgent(run.cycle, run.id);
  const round = (run.attempts["plan-review"] ?? 0) + 1;
  const panel = reviewers(run.cycle, author, cfg.planReviewQuorum, `${run.id}:plan-review:${round}`);
  const replies = flowText(run, "plan-replies.md");
  const statePath = planReviewStatePath(run.id);
  const reviewed = layered.state?.reviewed;
  const planKey = currentPlanKey(run);
  // 同一輪因某一呼叫失敗而重跑時，沿用已成功的呼叫：不重複付費，已套用的交接也不會被重新提出
  const progress: PlanReviewRound = roundProgress(layered.state, round, planKey) ?? { round, planKey, calls: [] };
  const saveState = (state: PlanReviewState) => {
    mkdirSync(runDir(run.id), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  };
  const done = new Map(progress.calls.map((call) => [call.key, call]));
  const calls: PlanReviewCall[] = [];
  // 沿用的呼叫也佔一格，重跑時每個呼叫的 slot 才不會變
  let nextSlot = 0;
  interface Item { key: string; taskIds?: string[]; spec: PlanReviewCallSpec; reused?: PlanReviewCall }
  const items: Item[] = [];
  const add = (key: string, taskIds: string[] | undefined, label: string, spec: Omit<PlanReviewCallSpec, "slot" | "key">) => {
    const reused = done.get(key);
    if (reused) info(run, `   ↪ 沿用本輪已完成的${label}（${reused.reviewer}）`);
    else info(run, `🧐 ${label}第 ${round} 輪（${spec.reviewer}，作者 ${author}）`);
    items.push({ key, taskIds, reused, spec: { ...spec, slot: nextSlot++, key } });
  };

  for (const reviewer of panel) {
    add(`index:${reviewer}`, undefined, "計畫索引審查", {
      reviewer, step: "plan-review", gated: true, subject: "計畫索引",
      prompt: renderPrompt("plan-review-index", {
        reviewer, author, requirement: run.requirement,
        index: planReviewIndex(layered.tasks),
        acceptance: JSON.stringify(layered.acceptance, null, 2),
        overview: planOverview(layered.planMd),
        replies,
      }),
      output: "plan-review.json", archive: `plan-review-${round}-${reviewer}.json`,
    });
  }
  for (const group of layered.dirty) {
    const groupTasks = layered.tasks.filter((task) => group.taskIds.includes(task.id));
    const acceptanceIds = new Set(groupTasks.flatMap((task) => task.acceptance));
    const neighbors = neighborTasks(layered.tasks, group.taskIds).map(({ id, title, description, dependsOn }) => ({ id, title, description, dependsOn }));
    const groupPanel = reviewers(run.cycle, author, groupReviewerCount(groupTasks, cfg.planReviewQuorum), `${run.id}:plan-group:${group.id}:${round}`);
    for (const reviewer of groupPanel) {
      add(`group:${group.id}:${group.taskIds.join(",")}:${reviewer}`, group.taskIds, `計畫群 ${group.id} 審查`, {
        reviewer, step: "plan-review-group", gated: false, subject: `任務群 ${group.id}`, scope: group.id,
        prompt: renderPrompt("plan-review-group", {
          reviewer, author, groupId: group.id,
          files: group.files.join("、") || "（這群的描述沒有點名檔案）",
          tasks: JSON.stringify(groupTasks, null, 2),
          neighbors: neighbors.length ? JSON.stringify(neighbors, null, 2) : "（沒有跨群的直接相依）",
          acceptance: JSON.stringify(layered.acceptance.filter((item) => acceptanceIds.has(item.id)), null, 2),
          evidence: extractPlanEvidence(layered.planMd, group.taskIds),
          replies: repliesForTasks(replies, group.taskIds),
        }),
        output: "plan-review-group.json", archive: `plan-review-${round}-${group.id}-${reviewer}.json`,
      });
    }
  }

  // 平行執行還沒套用的呼叫；沿用的（已套用、記在進度檔裡）不再跑
  const pending = items.filter((item) => !item.reused);
  const ran = await executeReviewCalls(run, cfg, "plan-review", `${round}:${planKey}`, pending.map((item) => item.spec));
  if (!ran) return run;

  // 序列收尾，依原本的順序逐一套用；每套用一個就寫進度檔，中途被中斷也不會重複套用
  const applied = new Map<string, PlanReviewCall>();
  for (const [i, item] of pending.entries()) {
    const passed = applyPlanReview(run, item.spec, ran.finished[i]!, ran.dir);
    run = passed.run;
    if (!passed.collected) return run;
    // 真的執行並成功就是有進展：同一輪不同呼叫輪流失敗時，不會累計到重試上限而讓 run 失敗。
    // 進度寫在 round 裡、不會重跑，所以一輪最多失敗「呼叫數 × maxAttempts」次。
    // 整份審查每次重跑整輪，不能這樣歸零，否則同一位審查者反覆失敗會無限重試。
    const attempts = { ...run.attempts };
    delete attempts["plan-review-run"];
    run = { ...run, attempts };
    const call: PlanReviewCall = { key: item.key, ...passed.collected, ...(item.taskIds ? { taskIds: item.taskIds } : {}) };
    progress.calls.push(call);
    applied.set(item.key, call);
    saveState({ version: 1, ...(reviewed ? { reviewed } : {}), round: progress });
  }
  calls.push(...items.map((item) => item.reused ?? applied.get(item.key)!));

  // 只放這一輪真的審過的群（含沿用的），沒審到的任務才留得住前次 verdict
  const groupVerdicts = calls.flatMap((call) => call.taskIds ? [{ taskIds: call.taskIds, verdict: call.verdict }] : []);
  saveState({ version: 1, reviewed: applyReviewVerdicts(reviewed, layered.tasks, layered.acceptance, layered.planMd, groupVerdicts) });
  return concludePlanReview(run, cfg, round, calls);
}

async function planFixStage(run: FlowRun): Promise<FlowRun> {
  const cfg = loadRepoConfig();
  const agent = planFixAgent(run.cycle, {
    strategy: cfg.fixStrategy,
    planWriter: run.planWriter,
    planReviewer: run.planReviewer,
    seed: `${run.id}:plan-fix:${run.attempts["plan-review"] ?? 0}`,
  });
  info(run, `✏️  依 ${run.planReviewer ?? "審查者"} 的意見修改計畫（${agent}）`);
  const feedback = readFeedback(run);
  const snap = snapshotPlan(run, PLAN_REPLY_FILES);
  // 回應每輪整份覆寫：先刪掉上一輪的，agent 沒寫時下一輪才不會讀到舊回應；失敗時快照會還原
  const clearReplies = () => rmSync(flowFile(run, "plan-replies.md"), { force: true });
  clearReplies();
  let outcome: StepOutcome;
  try {
    outcome = await agentStep(
      run, agent, "plan-fix",
      renderPrompt("plan-fix", { requirement: run.requirement, testPattern: cfg.testPattern }),
      { kind: "write", reset: async () => { await discardChanges(worktreeDir(run.id)); restorePlan(run, snap); clearReplies(); } },
    );
  } catch (err) {
    // 所有 agent 額度都用完而暫停：還原成進入時的內容，resume 前的計畫審查回應仍在
    restorePlan(run, snap);
    throw err;
  }
  const { r, agent: actual } = outcome;
  await discardChanges(worktreeDir(run.id)); // 只允許改 .flow/
  if (!r.ok) {
    restorePlan(run, snap);
    return retry(run, "plan-fix", `${feedback}\n\n（上次修改時 Agent 執行失敗：${r.summary}）`, "plan_fix", "agent_error");
  }
  const ordered = validatePlan(run);
  if (typeof ordered === "string") {
    restorePlan(run, snap);
    return retry(run, "plan-fix", `${feedback}\n\n另外，修改後的計畫沒有通過格式檢查，已還原：\n${ordered}`, "plan_fix", "format_invalid");
  }
  const handoffError = await settleHandoff(run, outcome, PLAN_REPLY_FILES);
  if (handoffError) {
    restorePlan(run, snap);
    // 計畫已還原，要保留原本的審查意見，否則下一次修正不知道要改什麼
    return retry(run, "plan-fix", `${feedback}\n\n另外，交接回覆不合格，本次修改已還原：${handoffError}`, "plan_fix", "handoff_invalid");
  }
  acceptPlan(run, ordered);
  writeFileSync(flowFile(run, "feedback.md"), feedback); // 保留審查意見，讓下一輪審查者知道上次提了什麼
  const attempts = { ...run.attempts };
  delete attempts["plan-fix"];
  return { ...run, attempts, stage: "plan_review", planWriter: actual };
}

/**
 * 仲裁：有第三方就由第三方判斷；只有兩家時，兩家各自在全新 context 中雙盲判斷，
 * 並且看不到誰是作者、誰是審查者。結果依 tieBreak 決定分歧時怎麼辦。
 */
async function arbitratePlan(run: FlowRun): Promise<FlowRun> {
  const cfg = loadRepoConfig();
  const arbitrationRound = (run.attempts["plan-arbitration"] ?? 0) + 1;
  const panel = arbiterPanel(run.cycle, `${run.id}:arbiter`, run.planWriter, run.planReviewer);
  const mode = panel.length > 1 ? "雙盲交叉仲裁" : "第三方仲裁";
  const verdicts: { arbiter: string; verdict: "approve" | "changes_requested" | "abstain"; notes: string[]; markdownNotes: string[] }[] = [];

  for (const [slot, arbiter] of panel.entries()) {
    info(run, `⚖️  ${mode}（${arbiter}）`);
    const snap = snapshotPlan(run, PLAN_REPLY_FILES);
    rmSync(flowFile(run, "plan-arbiter.json"), { force: true });
    const outcome = await agentStep(run, arbiter, "plan-arbiter", renderPrompt("plan-arbiter", { requirement: run.requirement }), {
      kind: "review", slot, blind: true,
      reset: async () => { await discardChanges(worktreeDir(run.id)); restorePlan(run, snap); },
    });
    const { r } = outcome;
    await discardChanges(worktreeDir(run.id));
    restorePlan(run, snap);
    const result = r.ok ? readJsonFile(flowFile(run, "plan-arbiter.json"), ArbiterResult) : undefined;
    const handoffError = result?.ok ? finishHandoff(run, outcome, "reviewer", { target: "plan", verdict: result.data.verdict }) : undefined;
    if (!result?.ok || handoffError) {
      const outputError = !r.ok ? `Agent 執行失敗：${r.summary}` : !result ? "未產生有效裁決" : result.ok ? "未產生有效裁決" : result.error;
      const reason = handoffError ?? outputError;
      const category: RetryCategory = handoffError ? "handoff_invalid" : !r.ok ? "agent_error" : "format_invalid";
      info(run, `   ✗ ${arbiter} 未產生有效裁決：${reason}`);
      // 無效的裁決移到 worktree 外保存，供事後查看；plan-arbitration.json 還在，重試時直接回到仲裁
      if (existsSync(flowFile(run, "plan-arbiter.json"))) {
        mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
        renameSync(flowFile(run, "plan-arbiter.json"), join(runDir(run.id), "reviews", `plan-arbiter-${arbitrationRound}-${arbiter}-invalid.json`));
      }
      return retry(run, "plan-arbitration-run", `上次仲裁未產生有效裁決：${reason}`, "plan_review", category);
    }
    mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
    renameSync(flowFile(run, "plan-arbiter.json"), join(runDir(run.id), "reviews", `plan-arbiter-${arbitrationRound}-${arbiter}.json`));
    const verdict = result.data.verdict;
    const notes = result.data.items.map((i) => `<issue criterion="${escapeXml(i.criterion)}">${escapeXml(i.note)}</issue>`);
    const markdownNotes = result.data.items.map((i) => `- ${i.criterion}：${i.note}`);
    info(run, `   ${verdict === "approve" ? "✓" : "✗"} ${arbiter}：${verdict === "approve" ? "可以執行" : "不可執行"}`);
    verdicts.push({ arbiter, verdict, notes, markdownNotes });
  }
  rmSync(flowFile(run, "dispute.md"), { force: true });
  rmSync(planArbitrationPath(run.id), { force: true });
  run = { ...run, attempts: { ...run.attempts } };
  delete run.attempts["plan-arbitration-run"];

  const approvals = verdicts.filter((v) => v.verdict === "approve").length;
  const unanimous = approvals === verdicts.length;
  const decision = arbitrationDecision(verdicts.map((v) => v.verdict), cfg.tieBreak);
  if (decision === "invalid") throw new Error("仲裁結果缺少有效裁決");
  const summary = unanimous
    ? `${mode}一致核准`
    : approvals === 0
      ? `${mode}沒有任何一方核准${decision === "revise" ? "，交回計畫修訂" : ""}`
      : `${mode}意見分歧，依 tieBreak=${cfg.tieBreak} ${cfg.tieBreak === "proceed" ? "繼續實作" : "停止"}`;

  const feedbackRecord = verdicts.map((v) => opinion(v.arbiter, v.notes, v.verdict)).join("\n\n");
  if (decision === "revise") {
    const attempts: Record<string, number> = { ...run.attempts, "plan-arbitration": arbitrationRound };
    delete attempts["plan-review"];
    rmSync(flowFile(run, "plan-review-last.txt"), { force: true });
    rmSync(planReviewStatePath(run.id), { force: true });
    addRetry(run.id, { key: "plan-arbitration", backTo: "plan_fix", category: "arbitration_revise", attempt: arbitrationRound, final: false }, run.updatedAt);
    writeFileSync(flowFile(run, "feedback.md"), `# 仲裁要求修訂（第 ${arbitrationRound} 次）\n\n${summary}\n\n${feedbackRecord}\n`);
    info(run, `   → ${summary}`);
    return { ...run, attempts, stage: "plan_fix" };
  }
  writeFileSync(
    flowFile(run, "plan.md"),
    `${readFileSync(flowFile(run, "plan.md"), "utf8")}\n\n## 仲裁紀錄\n\n**結果：${summary}**\n\n${verdicts.map((v) => `### ${v.arbiter}（${v.verdict}）\n\n${v.markdownNotes.join("\n")}`).join("\n\n")}\n`,
  );
  if (decision === "proceed") {
    info(run, `   → ${summary}`);
    return planSettled(run, "plan-review");
  }
  return { ...run, stage: "failed", failedStage: "plan_review", failureCategory: "arbitration_stop", failureReason: `${summary}，需要人工決定（見 plan.md 的仲裁紀錄）` };
}

function planTamperedMessage(files: string[]): string {
  return `計畫定案後不可修改規格與計畫檔，已還原你的變更：${files.map((f) => `.flow/${f}`).join(", ")}。若認為規格或驗收條件有誤，請寫進 .flow/handoff-response.json 的 newIssues。`;
}

async function implementStage(run: FlowRun): Promise<FlowRun> {
  const tasks = loadOrderedTasks(run);
  const task = tasks[run.taskIndex];
  if (!task) {
    info(run, "✅ 所有任務完成");
    announceConfirmations(run);
    return to(run, "verify");
  }
  const cfg = loadRepoConfig();
  const repo = worktreeDir(run.id);
  const testRe = new RegExp(cfg.testPattern);
  const testCmd = `${cfg.install} && ${cfg.test}`;
  const progress = `${run.taskIndex + 1}/${tasks.length} ${task.id} ${task.title}`;
  if (task.kind === "confirm") {
    rememberConfirmation(run, task);
    const rest = tasks.filter((item) => item.id !== task.id);
    writeFileSync(flowFile(run, "tasks.ordered.json"), JSON.stringify(rest, null, 2));
    info(run, `👀 [${progress}] 改放到待你確認的清單，實作繼續`);
    return run;
  }
  const taskJson = JSON.stringify(task, null, 2);
  const acceptance = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!acceptance.ok) throw new Error(acceptance.error);
  const acceptanceJson = JSON.stringify(taskAcceptance(task, acceptance.data), null, 2);
  // 上一次嘗試剛因「測試一開始就通過」被退回：測試只動了測試檔卻在既有程式上通過，表示行為早就存在
  // （例如前一個任務順手做掉了），再要求紅燈只會重試到上限。第二次起改為接受特徵化測試，由任務審查與驗證把關
  const redAlreadyGreen = run.taskPhase === "tests" && existsSync(flowFile(run, "feedback.md"))
    && readFileSync(flowFile(run, "feedback.md"), "utf8").includes(TESTS_NOT_RED_MARK);
  const waiveRed = task.tdd !== false && (descriptionWaivesRed(task.description) || redAlreadyGreen);
  if (run.taskPhase === "review") return taskReviewStep(run, task, progress, taskJson, acceptanceJson);
  if (run.taskPhase === "verify") return taskVerifyStep(run, task, progress);
  if (run.taskPhase === "fix") return taskFixStep(run, task, progress, tasks);
  const agents = taskAgents(run.cycle, run.taskIndex, cfg.tddSplit, run.id);
  const framework = hasTestFramework();
  const tdd = taskUsesTdd(task, framework);

  // ── 不走 TDD：略過紅燈，實作前的 HEAD 就是這個任務的起點 ──
  if (!tdd && run.taskPhase === "tests") {
    info(run, `⏭️  [${progress}] 略過 TDD（${framework ? "planner 標記不適合先寫測試" : "專案沒有測試框架"}）`);
    return { ...run, taskPhase: "code", taskBase: await headCommit(repo), testsCommit: undefined, lastTestsAuthor: undefined };
  }

  // ── 紅燈：只寫測試，而且測試必須失敗 ──
  if (run.taskPhase === "tests") {
    const key = `${task.id}:tests`;
    info(run, `🧪 [${progress}] 撰寫測試（${agents.tests}）`);
    if (waiveRed && existsSync(flowFile(run, "feedback.md")) && readFileSync(flowFile(run, "feedback.md"), "utf8").includes(TESTS_NOT_RED_MARK)) {
      rmSync(flowFile(run, "feedback.md"));
    }
    if (redAlreadyGreen) info(run, `ℹ️  [${progress}] 測試在既有實作上就通過，改為接受特徵化測試（不再要求紅燈）`);
    const before = await headCommit(repo);
    const snap = snapshotPlan(run, LOCKED_FILES);
    const outcome = await agentStep(
      run, agents.tests, `${task.id}-tests`,
      renderPrompt("implement-tests", { task: taskJson, acceptance: acceptanceJson, testPattern: cfg.testPattern, testCmd, ...testsRedGuidance(testCmd, waiveRed) }),
      { kind: "write", reset: async () => { await resetTo(repo, before); restorePlan(run, snap); } },
    );
    const { r, agent: testsAuthor } = outcome;
    const tampered = restorePlan(run, snap);
    if (!r.ok) {
      await resetTo(repo, before);
      return retry(run, key, `Agent 執行失敗：${r.summary}`, "implement", "agent_error");
    }
    if (tampered.length) {
      await resetTo(repo, before);
      return retry(run, key, planTamperedMessage(tampered), "implement", "plan_tampered");
    }
    const commit = await commitAll(repo, `test(${task.id}): ${task.title} [${testsAuthor}]`);
    if (!commit) {
      // 完全沒有變更：若現有測試已經通過，表示行為早就被既有測試涵蓋（例如前一個任務已寫過同樣的斷言），不必硬寫重複的測試
      const covered = await runCommand(target(run, redStepName(task.id), CMD_AGENT), testCmd);
      if (!covered.ok) return retry(run, key, "沒有任何檔案變更，這個階段必須撰寫測試。", "implement", "tests_not_written");
      const coveredError = await settleHandoff(run, outcome, LOCKED_FILES, before);
      if (coveredError) return retry(run, key, coveredError, "implement", "handoff_invalid");
      writeFileSync(flowFile(run, "red-output.txt"), "此任務沒有新增測試：既有測試已通過，視為已涵蓋。不要為了製造失敗而修改產品程式；若沒有其他必須的實作，保持現況即可。");
      info(run, `✅ [${progress}] 沒有新增測試，既有測試已通過，視為已涵蓋`);
      return { ...succeed(run, key, "implement"), taskPhase: "code", taskBase: before, testsCommit: before, lastTestsAuthor: testsAuthor };
    }
    const changed = await changedFiles(repo, before, commit);
    if (!changed.some((f) => testRe.test(f))) {
      await resetTo(repo, before);
      return retry(run, key, `沒有新增或修改任何符合 /${cfg.testPattern}/ 的測試檔。`, "implement", "tests_not_written");
    }
    const red = await runCommand(target(run, redStepName(task.id), CMD_AGENT), testCmd);
    if (red.ok && !waiveRed) {
      await resetTo(repo, before);
      return retry(run, key, TESTS_NOT_RED_REASON, "implement", "tests_not_red");
    }
    const handoffError = await settleHandoff(run, outcome, LOCKED_FILES, before);
    if (handoffError) {
      await resetTo(repo, before);
      return retry(run, key, handoffError, "implement", "handoff_invalid");
    }
    writeFileSync(
      flowFile(run, "red-output.txt"),
      waiveRed && red.ok
        ? "此任務不要求紅燈，測試在既有實作下已經通過。不要為了製造失敗而修改產品程式；若沒有其他必須的實作，保持現況即可。"
        : red.output,
    );
    info(run, waiveRed && red.ok ? `✅ [${progress}] 測試已寫好（此任務不要求紅燈）` : `🔴 [${progress}] 測試如預期失敗`);
    return { ...succeed(run, key, "implement"), taskPhase: "code", taskBase: before, testsCommit: commit, lastTestsAuthor: testsAuthor };
  }

  // ── 綠燈：實作到測試通過，而且不可動測試 ──
  const key = `${task.id}:code`;
  // 走 TDD 時以測試 commit 為基準；不走 TDD 時以任務起點為基準
  const testsCommit = tdd ? run.testsCommit : run.taskBase;
  if (!testsCommit) throw new Error(tdd ? "缺少 testsCommit，狀態不一致" : "缺少 taskBase，狀態不一致");
  info(run, tdd ? `🛠️  [${progress}] 實作（${agents.code}，測試由 ${run.lastTestsAuthor ?? agents.tests} 撰寫）` : `🛠️  [${progress}] 實作（${agents.code}，不走 TDD）`);
  const redOutput = existsSync(flowFile(run, "red-output.txt")) ? readFileSync(flowFile(run, "red-output.txt"), "utf8") : "";
  const snap = snapshotPlan(run, LOCKED_FILES);
  const outcome = await agentStep(
    run, agents.code, `${task.id}-code`,
    tdd
      ? renderPrompt("implement-code", { task: taskJson, acceptance: acceptanceJson, testCmd, redOutput: tail(redOutput, 3000) })
      : renderPrompt("implement-direct", { task: taskJson, acceptance: acceptanceJson, testCmd: framework ? testCmd : "" }),
    { kind: "write", reset: async () => { await resetTo(repo, testsCommit); restorePlan(run, snap); } },
  );
  const { r, agent: codeAuthor } = outcome;
  const tampered = restorePlan(run, snap);
  if (!r.ok) return retry(run, key, `Agent 執行失敗：${r.summary}`, "implement", "agent_error");
  if (tampered.length) {
    await resetTo(repo, testsCommit);
    return retry(run, key, planTamperedMessage(tampered), "implement", "plan_tampered");
  }
  const codeCommit = await commitAll(repo, `feat(${task.id}): ${task.title} [${codeAuthor}]`);
  if (!tdd && !codeCommit) {
    info(run, `⏭️  [${progress}] 沒有檔案變更，略過這個任務`);
    return finishTask(succeed(run, key, "implement"));
  }
  const touched = tdd ? (await changedFiles(repo, testsCommit, await headCommit(repo))).filter((f) => testRe.test(f)) : [];
  if (touched.length) {
    await resetTo(repo, testsCommit);
    return retry(run, key, `實作階段不可修改測試檔，已還原你的變更：${touched.join(", ")}`, "implement", "tests_modified");
  }
  if ((run.attempts[key] ?? 0) < SCOPE_GUARD_ATTEMPTS) {
    const strays = outOfScopeFiles(tasks, run.taskIndex, await changedFiles(repo, testsCommit, await headCommit(repo)));
    if (strays.length) {
      await resetTo(repo, testsCommit);
      return retry(run, key, outOfScopeMessage(strays), "implement", "out_of_scope");
    }
  }
  // 沒有測試框架時沒有東西可跑，後面的驗證與審查照常把關
  const green = framework ? await runCommand(target(run, `${task.id}-green`, CMD_AGENT), testCmd) : { ok: true as const, output: "", seq: 0 };
  if (!green.ok) {
    info(run, `   ✗ 測試仍未通過${logHint(run, green.seq)}`);
    return retry(run, key, `測試仍未通過：\n\n\`\`\`\n${tail(green.output)}\n\`\`\``, "implement", "tests_not_green");
  }
  const handoffError = await settleHandoff(run, outcome, LOCKED_FILES, testsCommit);
  if (handoffError) {
    await resetTo(repo, testsCommit);
    return retry(run, key, handoffError, "implement", "handoff_invalid");
  }
  info(run, framework ? `🟢 [${progress}] 測試通過` : `✔️  [${progress}] 實作完成`);
  return { ...succeed(run, key, "implement"), taskPhase: "review", lastWriter: codeAuthor };
}

// ── 任務審查：只看這個任務的變更與驗收條件 ──
async function taskReviewStep(run: FlowRun, task: TaskItem, progress: string, taskJson: string, acceptanceJson: string): Promise<FlowRun> {
  const key = `${task.id}:review`;
  const base = run.taskBase ?? (run.testsCommit && `${run.testsCommit}~1`);
  if (!base) throw new Error("缺少 taskBase，狀態不一致");
  const result = await codeReview(run, {
    base,
    seed: `${run.id}:review:${task.id}:${run.attempts[key] ?? 0}`,
    label: `[${progress}] 任務審查`,
    step: `${task.id}-review`,
    prompt: (reviewer, authors) => renderPrompt("task-review", { reviewer, authors, task: taskJson, acceptance: acceptanceJson }),
    saveAs: (reviewer) => `review-${task.id}-${reviewer}.json`,
    testAuthor: run.lastTestsAuthor,
    // 輪流交換角色：優先由排定的審查者審查，讓各家用量平均
    prefer: taskAgents(run.cycle, run.taskIndex, loadRepoConfig().tddSplit, run.id).review,
    // 未結交接事項可能屬於後面的任務，由最後的整體審查把關
    gate: false,
    runKey: `${task.id}:review-run`,
    backTo: "implement",
  });
  if ("run" in result) return result.run;
  const reviewed = succeed(result.state, `${task.id}:review-run`, "implement");
  if (!result.objector) return { ...succeed(reviewed, key, "implement"), taskPhase: "verify" };
  return {
    ...retry(reviewed, key, `任務審查要求修改：\n\n${result.issues.join("\n\n")}`, "implement", "review_changes"),
    taskPhase: "fix",
    fixSource: "review",
    lastReviewer: result.objector,
  };
}

/** 這個任務結束，下一個從寫測試開始 */
function finishTask(run: FlowRun): FlowRun {
  return {
    ...run,
    taskIndex: run.taskIndex + 1,
    taskPhase: "tests",
    taskBase: undefined,
    testsCommit: undefined,
    lastTestsAuthor: undefined,
  };
}

// ── 任務驗證：通過才進入下一個任務 ──
async function taskVerifyStep(run: FlowRun, task: TaskItem, progress: string): Promise<FlowRun> {
  const key = `${task.id}:verify`;
  info(run, `🔍 [${progress}] 執行驗證`);
  const report = await runChecks(run, `${task.id}-`);
  if (report) return { ...retry(run, key, report, "implement", "checks_failed"), taskPhase: "fix", fixSource: "verify" };
  info(run, `✅ [${progress}] 完成`);
  return finishTask(succeed(run, key, "implement"));
}

// ── 任務修正：修完重新審查、驗證 ──
async function taskFixStep(run: FlowRun, task: TaskItem, progress: string, tasks: TaskItem[]): Promise<FlowRun> {
  const result = await applyFix(run, {
    seed: `${run.id}:fix:${task.id}:${run.attempts[`${task.id}:review`] ?? 0}`,
    label: `[${progress}] `,
    step: `${task.id}-fix`,
    commitScope: `fix(${task.id})`,
    key: `${task.id}:fix`,
    backTo: "implement",
    scopeGuard: (changed) => {
      const strays = outOfScopeFiles(tasks, run.taskIndex, changed);
      return strays.length ? outOfScopeMessage(strays) : undefined;
    },
  });
  if ("run" in result) return result.run;
  return { ...succeed(run, `${task.id}:fix`, "implement"), taskPhase: "review", lastWriter: result.agent };
}

/** 執行 install 與所有 checks，結果寫入 verify.json；有失敗時回傳給修正者的報告 */
async function runChecks(run: FlowRun, stepPrefix = ""): Promise<string | undefined> {
  const cfg = loadRepoConfig();
  const results: { name: string; ok: boolean; output: string }[] = [];
  const install = await runCommand(target(run, `${stepPrefix}install`, CMD_AGENT), cfg.install);
  if (!install.ok) {
    info(run, `   ✗ install${logHint(run, install.seq)}`);
    results.push({ name: "install", ok: false, output: tail(install.output) });
  } else {
    for (const check of cfg.checks) {
      const r = await runCommand(target(run, `${stepPrefix}${check.name}`, CMD_AGENT), check.cmd);
      info(run, `   ${r.ok ? "✓" : "✗"} ${check.name}${r.ok ? "" : logHint(run, r.seq)}`);
      results.push({ name: check.name, ok: r.ok, output: tail(r.output, 3000) });
    }
  }
  writeFileSync(flowFile(run, "verify.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return undefined;
  return failed.map((f) => `## ${f.name} 失敗\n\n\`\`\`\n${f.output}\n\`\`\``).join("\n\n");
}

async function verifyStage(run: FlowRun): Promise<FlowRun> {
  info(run, "🔍 執行驗證");
  const report = await runChecks(run);
  if (!report) return succeed(run, "verify", "review");
  return { ...retry(run, "verify", report, "fix", "checks_failed"), fixSource: "verify" };
}

/** 修正驗證錯誤或審查意見；成功時回傳實際修正者，未通過時回傳重試後的 run */
async function applyFix(
  run: FlowRun,
  opts: { seed: string; label: string; step: string; commitScope: string; key: string; backTo: Stage; scopeGuard?: (changed: string[]) => string | undefined },
): Promise<{ run: FlowRun } | { agent: string }> {
  const cfg = loadRepoConfig();
  const source = run.fixSource ?? "verify";
  const agent = fixAgent(run.cycle, {
    source,
    strategy: cfg.fixStrategy,
    lastWriter: run.lastWriter,
    lastReviewer: run.lastReviewer,
    seed: opts.seed,
  });
  const why = source === "review" ? `依 ${run.lastReviewer ?? "reviewer"} 的審查意見` : "修正驗證錯誤";
  info(run, `🩹 ${opts.label}${why}（${agent}）`);
  const repo = worktreeDir(run.id);
  const feedback = readFeedback(run);
  const before = await headCommit(repo);
  const snap = snapshotPlan(run, LOCKED_FILES);
  const outcome = await agentStep(run, agent, opts.step, renderPrompt("fix", { testPattern: cfg.testPattern }), {
    kind: "write",
    reset: async () => { await resetTo(repo, before); restorePlan(run, snap); },
  });
  const { r, agent: actual } = outcome;
  const tampered = restorePlan(run, snap);
  const again = (reason: string, category: RetryCategory) => ({ run: retry(run, opts.key, reason, opts.backTo, category) });
  if (!r.ok) return again(`${feedback}\n\n（上次修正時 Agent 執行失敗：${r.summary}）`, "agent_error");
  if (tampered.length) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外：${planTamperedMessage(tampered)}`, "plan_tampered");
  }
  await commitAll(repo, `${opts.commitScope}: ${why} [${actual}]`);
  const stray = (run.attempts[opts.key] ?? 0) < SCOPE_GUARD_ATTEMPTS
    ? opts.scopeGuard?.(await changedFiles(repo, before, await headCommit(repo)))
    : undefined;
  if (stray) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外：${stray}`, "out_of_scope");
  }
  const testRe = new RegExp(cfg.testPattern);
  const deleted = (await changedFiles(repo, before, await headCommit(repo), "D")).filter((f) => testRe.test(f));
  if (deleted.length) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外：不可刪除測試檔來讓檢查通過，已還原：${deleted.join(", ")}`, "tests_deleted");
  }
  const handoffError = await settleHandoff(run, outcome, LOCKED_FILES, before);
  if (handoffError) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外，交接回覆不合格，本次修正已還原：${handoffError}`, "handoff_invalid");
  }
  return { agent: actual };
}

async function fixStage(run: FlowRun): Promise<FlowRun> {
  const result = await applyFix(run, {
    seed: `${run.id}:fix:${run.attempts.review ?? 0}`,
    label: "",
    step: "fix",
    commitScope: "fix",
    key: "fix",
    backTo: "fix",
  });
  if ("run" in result) return result.run;
  // 修正者成為新的作者，下一輪審查會換成別人
  return { ...succeed(run, "fix", "verify"), lastWriter: result.agent };
}

/**
 * 由作者以外的審查小組審查 base 之後的變更；回傳第一位要求修改的審查者與所有意見，
 * 審查本身未完成（執行失敗、格式錯誤、交接不合格）時回傳重試後的 run。
 * gate 為 true 時，核准前必須結清所有程式碼類的未結交接事項。
 */
async function codeReview(
  run: FlowRun,
  opts: {
    base: string; seed: string; label: string; step: string;
    prompt: (reviewer: string, authors: string) => string;
    saveAs: (reviewer: string) => string;
    gate: boolean; runKey: string; backTo: Stage; testAuthor?: string; prefer?: string;
  },
): Promise<{ run: FlowRun } | { state: FlowRun; objector?: string; issues: string[] }> {
  const cfg = loadRepoConfig();
  const repo = worktreeDir(run.id);
  const panel = reviewers(run.cycle, run.lastWriter, cfg.reviewQuorum, opts.seed, opts.testAuthor, opts.prefer);
  // 審查的是 HEAD：先清掉驗證階段留下的未 commit 修改與未追蹤產物，之後修正時的 commitAll 才不會把它們帶進去（.flow/ 在 exclude 內不受影響）
  await discardChanges(repo);
  writeFileSync(flowFile(run, "diff.patch"), await git(repo, "diff", `${opts.base}...HEAD`));
  const authors = [...new Set((await git(repo, "log", "--format=%s", `${opts.base}..HEAD`)).match(/\[[^\]]+\]$/gm) ?? [])]
    .map((s) => s.slice(1, -1));

  const specs: ReviewCall[] = panel.map((reviewer, slot) => ({
    key: `${slot}:${reviewer}`, slot, reviewer, step: opts.step,
    prompt: opts.prompt(reviewer, authors.join("、") || "未知"),
    output: "review.json",
  }));
  for (const spec of specs) info(run, `👀 ${opts.label}（${spec.reviewer}）`);
  // 指紋含 HEAD：程式碼被修過就不沿用舊的審查結果
  const ran = await executeReviewCalls(run, cfg, opts.step, `${opts.seed}|${await headCommit(repo)}|${opts.base}`, specs);
  if (!ran) return { run };

  const issues: string[] = [];
  let objector: string | undefined;
  for (const [i, spec] of specs.entries()) {
    const reviewer = spec.reviewer;
    const done = ran.finished[i]!;
    const fail = (reason: string, category: RetryCategory) => {
      dropCall(ran.dir, spec.key); // 不合格的存檔不能留著，否則同一輪重跑會讀到同一份
      return { run: retry(opts.step === "review" ? recordModelReviewFailure(run, "review", reviewer) : run, opts.runKey, reason, opts.backTo, category) };
    };
    if (!done.ok) return fail(`Agent 執行失敗：${done.stored.summary}`, "agent_error");
    replay(run, done.stored, "review.json");
    const review = readJsonFile(flowFile(run, "review.json"), ConsistentReviewResult);
    if (!review.ok) return fail(review.error, "format_invalid");
    const gate = opts.gate ? { target: "code" as const, verdict: review.data.verdict } : undefined;
    // 門檻以這個呼叫自己看到的帳本評估：同輪其他審查者剛新增（或崩潰前已套用）的事項它沒看過，不能拿來判它矛盾
    const handoffError = finishHandoff(run, storedOutcome(done.stored, true), "reviewer", gate, done.stored.base);
    if (handoffError) return fail(handoffError, "handoff_invalid");
    if (opts.step === "review") run = clearModelReviewFailure(run, "review", reviewer);
    renameSync(flowFile(run, "review.json"), flowFile(run, opts.saveAs(reviewer)));
    if (review.data.verdict === "approve") {
      info(run, `   ✓ ${reviewer} 核准`);
      continue;
    }
    info(run, `   ✗ ${reviewer} 要求修改`);
    objector ??= reviewer;
    issues.push(opinion(reviewer, review.data.items
      .filter((i) => i.status !== "met")
      .map((i) => reviewIssue(i.criterion, i.status, i.note))));
  }
  if (opts.step === "review") run = clearModelReviewStage(run, "review");
  const attempts = { ...run.attempts };
  delete attempts[opts.runKey];
  return { state: { ...run, attempts }, objector, issues };
}

async function reviewStage(run: FlowRun): Promise<FlowRun> {
  const result = await codeReview(run, {
    base: run.baseBranch,
    seed: `${run.id}:review:${run.attempts.review ?? 0}`,
    label: "程式碼審查",
    step: "review",
    prompt: (reviewer, authors) => renderPrompt("review", { reviewer, authors }),
    saveAs: (reviewer) => `review-${reviewer}.json`,
    gate: true,
    runKey: "review-run",
    backTo: "review",
  });
  if ("run" in result) return result.run;
  if (!result.objector) return succeed(result.state, "review", "pr");
  return {
    ...retry(result.state, "review", `程式碼審查要求修改：\n\n${result.issues.join("\n\n")}`, "fix", "review_changes"),
    fixSource: "review",
    lastReviewer: result.objector,
  };
}

async function prStage(run: FlowRun): Promise<FlowRun> {
  const pending = openActions(readHandoff(run.id));
  if (pending.length) return { ...run, stage: "failed", failedStage: "pr", failureCategory: "open_handoff", failureReason: `仍有未結交接事項：${pending.map((item) => item.id).join("、")}` };
  const repo = worktreeDir(run.id);
  const remotes = (await git(repo, "remote")).split("\n").filter(Boolean);
  if (!remotes.includes("origin")) {
    info(run, `✅ 沒有 origin，分支 ${run.branch} 已在本機 repo 中，可以直接檢視或合併`);
    return to(run, "done");
  }
  info(run, "🚀 推送分支");
  await git(repo, "push", "-u", "origin", run.branch);
  const title = run.requirement.split("\n")[0]!.slice(0, 72);
  const spec = existsSync(flowFile(run, "spec.md")) ? readFileSync(flowFile(run, "spec.md"), "utf8") : "";
  const bodyPath = join(runDir(run.id), "pr-body.md");
  writeFileSync(
    bodyPath,
    `> 由 agentflowctl 自動產生（run: ${run.id}，參與的 agent：${run.cycle.join("、")}，執行 agent ${agentRuns(run.id)} 次）\n\n${spec}`,
  );
  const r = await exec(
    "gh",
    ["pr", "create", "--head", run.branch, "--base", run.baseBranch, "--title", title, "--body-file", bodyPath],
    { cwd: repo },
  );
  if (r.code !== 0) {
    info(run, `⚠️  gh pr create 失敗，分支已推送，請手動建立 PR：${r.stderr.trim()}`);
    return to(run, "done");
  }
  return { ...to(run, "done"), prUrl: r.stdout.trim() };
}

// ───────────────────────── 狀態機 ─────────────────────────

type ActiveStage = Exclude<Stage, "done" | "failed" | "awaiting_approval" | "paused">;

const STAGES: Record<ActiveStage, (run: FlowRun) => Promise<FlowRun>> = {
  spec: specStage,
  plan: planStage,
  plan_review: planReviewStage,
  plan_fix: planFixStage,
  implement: implementStage,
  verify: verifyStage,
  fix: fixStage,
  review: reviewStage,
  pr: prStage,
};

/** 一路推進到需要人介入（awaiting_approval、paused）或結束（done / failed）為止；每一步都寫回檔案，中斷後可接續 */
export async function advance(initial: FlowRun): Promise<FlowRun> {
  let run = initial;
  recoverHandoff(run.id);
  await cleanupTempWorktrees(run.id); // 上次被中斷（Ctrl-C、SIGTERM、當機）時留下的平行審查臨時 worktree
  for (;;) {
    if (["done", "failed", "awaiting_approval", "paused"].includes(run.stage)) return run;
    const stage = run.stage as ActiveStage;
    const runs = agentRuns(run.id);
    if (runs >= run.maxAgentRuns) {
      return saveRun({
        ...run,
        stage: "failed",
        failedStage: stage,
        failureCategory: "agent_budget",
        failureReason: `已執行 agent ${runs} 次，達到上限 ${run.maxAgentRuns}（可用 resume --max-agent-runs 調高）`,
      });
    }
    try {
      run = saveRun(pauseAtStopAfter(run, await STAGES[stage](run)));
    } catch (err) {
      if (err instanceof QuotaPause) {
        info(run, `⏸️  暫停：${err.message}`);
        return saveRun({ ...run, stage: "paused", pausedStage: stage, pauseReason: err.message });
      }
      return saveRun({ ...run, stage: "failed", failedStage: stage, failureCategory: "error", failureReason: (err as Error).message });
    }
  }
}
