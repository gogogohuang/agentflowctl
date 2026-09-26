import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { arbitrationDecision } from "./arbitration.js";
import { detectProjectDefaults, withProjectDefaults } from "./detect.js";
import { escapeXml, opinion, reviewIssue } from "./feedback.js";
import { changedFiles, commitAll, discardChanges, git, headCommit, resetTo } from "./git.js";
import { acceptHandoff, openActions, prepareHandoff, previewHandoff, readHandoff, recoverHandoff, reviewHandoffGate, validateHandoffResponse } from "./handoff.js";
import { flowDir, logDir, projectRoot, runDir, worktreeDir } from "./paths.js";
import { CMD_AGENT, nextLogFile } from "./logs.js";
import { exec } from "./proc.js";
import { arbiterPanel, availableAgent, fixAgent, planAgent, planFixAgent, reviewers, specAgent, taskAgents } from "./roles.js";
import { resolveAgent, runAgent, runCommand, type AgentResult, type AgentTarget } from "./runner.js";
import {
  AcceptanceList,
  ArbiterResult,
  ConsistentReviewResult,
  RepoConfig,
  TaskItem,
  TaskList,
  type FlowRun,
  type Stage,
} from "./schemas.js";
import { addSubstitution, addUsage, agentRuns, saveRun } from "./store.js";
import { orderTasks, taskAcceptance } from "./tasks.js";
import { readJsonFile, renderPrompt, tail } from "./util.js";

// ───────────────────────── 共用工具 ─────────────────────────

const info = (run: FlowRun, msg: string) => console.log(`[${run.id}] ${msg}`);
const logHint = (run: FlowRun, seq: number) => `（agentflowctl logs ${run.id} ${seq}）`;
const flowFile = (run: FlowRun, name: string) => join(flowDir(run.id), name);
const to = (run: FlowRun, stage: Stage): FlowRun => ({ ...run, stage });

function target(run: FlowRun, step: string, agent: string): AgentTarget {
  return { runId: run.id, cwd: worktreeDir(run.id), logFile: nextLogFile(logDir(run.id), run.stage, step, agent), stage: run.stage, step };
}

/** 額度用完而必須停下：審查類步驟，或所有 agent 的額度都用完 */
export class QuotaPause extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** 這次執行中已確認額度用完的 agent；程序結束即清空，resume 時會重新嘗試 */
const exhausted = new Set<string>();

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
  slot?: number;
  blind?: boolean;
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
  const reset = mode.reset ?? (() => discardChanges(worktreeDir(run.id)));
  let agent = planned;
  for (;;) {
    if (exhausted.has(agent)) {
      if (mode.kind === "review") {
        throw new QuotaPause(`${agent} 的額度已用完；${step} 是審查步驟，不由另一家代打`);
      }
      const sub = availableAgent(run.cycle, agent, [...exhausted], `${run.id}:${step}:sub`);
      if (!sub) throw new QuotaPause(`所有 agent 的額度都已用完（${[...exhausted].join("、")}）`);
      const note = step.endsWith("-code") && sub === run.lastTestsAuthor ? "測試與實作由同一家負責" : undefined;
      addSubstitution(run.id, { step, planned, actual: sub, note });
      info(run, `🔁 ${agent} 額度已用完，${step} 由 ${sub} 代打${note ? `（注意：${note}）` : ""}`);
      agent = sub;
    }
    const callKey = handoffKey(run, step, mode.slot ?? 0, agent);
    prepareHandoff(run.id, callKey, handoffTarget(run), mode.blind ?? false);
    const r = await runAgent(agent, resolveAgent(cfg, agent), target(run, step, agent), prompt);
    addUsage(run.id, { stage: step, agent, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    if (!r.quotaExhausted) {
      reportMeta(run, agent, r);
      return { r, agent, step, callKey };
    }
    info(run, `⛽ ${agent} 的額度已用完`);
    exhausted.add(agent);
    await reset();
    // 迴圈回到開頭：review 會停下，write 會找代打
  }
}

/** 原有關卡已通過後才接受交接；失敗回覆不進入正式紀錄。 */
function finishHandoff(
  run: FlowRun, outcome: StepOutcome, role: "writer" | "reviewer",
  gate?: { target: "plan" | "code"; verdict: "approve" | "changes_requested" },
): string | undefined {
  const parsed = validateHandoffResponse(run.id);
  if (!parsed.ok) return parsed.error;
  try {
    const source = {
      stage: run.stage, step: outcome.step, agent: outcome.agent, callKey: outcome.callKey,
    };
    const preview = previewHandoff(readHandoff(run.id), outcome.callKey, source, parsed.data, role);
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

/** 印出回覆裡的 XML 中繼資料；只供人檢視，關卡仍由程式檢查決定 */
function reportMeta(run: FlowRun, agent: string, r: AgentResult): void {
  if (!r.meta) return;
  if (r.meta.status === "blocked") info(run, `   🚧 ${agent} 回報卡住：${r.meta.summary}`);
  if (r.meta.concerns) info(run, `   💭 ${agent} 的疑慮：${r.meta.concerns}`);
}

function readFeedback(run: FlowRun): string {
  const p = flowFile(run, "feedback.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 關卡未通過：寫入 feedback.md 給下一次嘗試參考，超過上限就讓整個 run 失敗 */
function retry(run: FlowRun, key: string, reason: string, backTo: Stage): FlowRun {
  const n = (run.attempts[key] ?? 0) + 1;
  const attempts = { ...run.attempts, [key]: n };
  mkdirSync(flowDir(run.id), { recursive: true });
  writeFileSync(flowFile(run, "feedback.md"), `# 前次嘗試未通過（第 ${n} 次）\n\n${reason}\n`);
  if (n >= config.maxAttempts) {
    return { ...run, attempts, stage: "failed", failedStage: backTo, failureReason: `${key} 連續失敗 ${n} 次：${tail(reason, 500)}` };
  }
  info(run, `⚠️  ${key} 未通過，重試（${n}/${config.maxAttempts}）`);
  return { ...run, attempts, stage: backTo };
}

function succeed(run: FlowRun, key: string, next: Stage): FlowRun {
  rmSync(flowFile(run, "feedback.md"), { force: true });
  const attempts = { ...run.attempts };
  delete attempts[key];
  return { ...run, attempts, stage: next };
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

function loadOrderedTasks(run: FlowRun): TaskItem[] {
  const r = readJsonFile(flowFile(run, "tasks.ordered.json"), TaskList);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// ───────────────────────── 各階段 ─────────────────────────

async function specStage(run: FlowRun): Promise<FlowRun> {
  const agent = specAgent(run.cycle, run.id);
  info(run, `📝 產生規格（${agent}）`);
  const outcome = await agentStep(run, agent, "spec", renderPrompt("spec", { requirement: run.requirement }), { kind: "write" });
  const { r } = outcome;
  await discardChanges(worktreeDir(run.id)); // 這個階段只允許寫 .flow/
  if (!r.ok) return retry(run, "spec", `Agent 執行失敗：${r.summary}`, "spec");
  if (!existsSync(flowFile(run, "spec.md"))) return retry(run, "spec", "缺少 .flow/spec.md", "spec");
  const ac = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!ac.ok) return retry(run, "spec", ac.error, "spec");
  const ids = ac.data.map((a) => a.id);
  if (new Set(ids).size !== ids.length) return retry(run, "spec", "驗收條件 id 有重複", "spec");
  const handoffError = finishHandoff(run, outcome, "writer");
  if (handoffError) return retry(run, "spec", handoffError, "spec");
  return succeed(run, "spec", "plan");
}

// ── 規格與計畫檔案：計畫審查、仲裁與計畫定案後的所有階段只能讀，不能改 ──

const PLAN_FILES = ["spec.md", "acceptance.json", "plan.md", "tasks.json"] as const;
/** 計畫定案後（實作、修正、程式碼審查）另外依賴排好的任務順序，同樣不能被改 */
const LOCKED_FILES = [...PLAN_FILES, "tasks.ordered.json"] as const;

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
  return orderTasks(tasks.data, new Set(ids));
}

function acceptPlan(run: FlowRun, ordered: TaskItem[]): void {
  writeFileSync(flowFile(run, "tasks.ordered.json"), JSON.stringify(ordered, null, 2));
}

function announceTasks(run: FlowRun, ordered: TaskItem[]): void {
  const cfg = loadRepoConfig();
  info(run, `📋 共 ${ordered.length} 個任務：${ordered.map((t) => t.id).join(" → ")}`);
  ordered.forEach((t, i) => {
    const a = taskAgents(run.cycle, i, cfg.tddSplit, run.id);
    info(run, `   ${t.id} 測試：${a.tests}　實作：${a.code}`);
  });
}

/** 計畫定案後：預設直接開始實作；--manual-plan 時才停下來等人 */
function planSettled(run: FlowRun, key: string): FlowRun {
  const pending = openActions(readHandoff(run.id), "plan");
  if (pending.length) return retry(run, "plan-handoff", `計畫仍有未結交接事項：${pending.map((item) => item.id).join("、")}`, "plan_fix");
  const next = run.autopilot ? "implement" : "awaiting_approval";
  const ordered = loadOrderedTasks(run);
  announceTasks(run, ordered);
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
  if (!r.ok) return retry(run, "plan", `Agent 執行失敗：${r.summary}`, "plan");
  const ordered = validatePlan(run);
  if (typeof ordered === "string") return retry(run, "plan", ordered, "plan");
  const handoffError = finishHandoff(run, outcome, "writer");
  if (handoffError) return retry(run, "plan", handoffError, "plan");
  acceptPlan(run, ordered);
  rmSync(flowFile(run, "plan-review-last.txt"), { force: true });
  return { ...succeed(run, "plan", "plan_review"), planWriter: actual };
}

async function planReviewStage(run: FlowRun): Promise<FlowRun> {
  const cfg = loadRepoConfig();
  const author = run.planWriter ?? planAgent(run.cycle, run.id);
  const round = (run.attempts["plan-review"] ?? 0) + 1;
  const panel = reviewers(run.cycle, author, cfg.planReviewQuorum, `${run.id}:plan-review:${round}`);

  const issues: string[] = [];
  const issueLines: string[] = []; // 只含意見內容、不含審查者名稱，用來偵測僵持
  let firstObjector: string | undefined;
  for (const reviewer of panel) {
    info(run, `🧐 計畫審查第 ${round} 輪（${reviewer}，作者 ${author}）`);
    const snap = snapshotPlan(run);
    rmSync(flowFile(run, "plan-review.json"), { force: true });
    const outcome = await agentStep(
      run, reviewer, "plan-review",
      renderPrompt("plan-review", { reviewer, author, requirement: run.requirement }),
      { kind: "review", slot: panel.indexOf(reviewer), reset: async () => { await discardChanges(worktreeDir(run.id)); restorePlan(run, snap); } },
    );
    const { r } = outcome;
    await discardChanges(worktreeDir(run.id));
    const tampered = restorePlan(run, snap);
    if (tampered.length) info(run, `   ↩️  已還原審查者修改的檔案：${tampered.join(", ")}`);
    if (!r.ok) return retry(run, "plan-review-run", `Agent 執行失敗：${r.summary}`, "plan_review");
    const review = readJsonFile(flowFile(run, "plan-review.json"), ConsistentReviewResult);
    if (!review.ok) return retry(run, "plan-review-run", review.error, "plan_review");
    const handoffError = finishHandoff(run, outcome, "reviewer", { target: "plan", verdict: review.data.verdict });
    if (handoffError) return retry(run, "plan-review-run", handoffError, "plan_review");
    // 審查紀錄移到 worktree 外面：之後的仲裁者看不到是哪一家提的意見
    mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
    renameSync(flowFile(run, "plan-review.json"), join(runDir(run.id), "reviews", `plan-review-${round}-${reviewer}.json`));
    if (review.data.verdict === "approve") {
      info(run, `   ✓ ${reviewer} 核准計畫`);
      continue;
    }
    info(run, `   ✗ ${reviewer} 要求修改計畫`);
    firstObjector ??= reviewer;
    const lines = review.data.items
      .filter((i) => i.status !== "met")
      .map((i) => reviewIssue(i.criterion, i.status, i.note));
    issueLines.push(...lines);
    issues.push(opinion(reviewer, lines));
  }
  if (!firstObjector) return planSettled(run, "plan-review");

  const report = `計畫審查要求修改：\n\n${issues.join("\n\n")}`;
  // 僵持偵測：意見和上一輪完全相同，代表修改沒有進展
  const lastPath = flowFile(run, "plan-review-last.txt");
  const fingerprint = [...issueLines].sort().join("\n");
  const stalled = existsSync(lastPath) && readFileSync(lastPath, "utf8") === fingerprint;
  writeFileSync(lastPath, fingerprint);
  const exhausted = round >= config.maxAttempts;
  if ((stalled || exhausted) && cfg.planArbiter) {
    // 雙盲：帶有審查者名稱的 feedback.md 不留在 worktree，完整報告另存到 worktree 外
    rmSync(flowFile(run, "feedback.md"), { force: true });
    mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
    writeFileSync(join(runDir(run.id), "reviews", "dispute-full.md"), report);
    // 給仲裁者的爭議清單不含任何模型名稱
    writeFileSync(flowFile(run, "dispute.md"), `# 尚未解決的審查意見\n\n${[...new Set(issueLines)].join("\n")}\n`);
    info(run, `⚖️  計畫審查${stalled ? "意見沒有變化" : `已達 ${round} 輪`}，交付仲裁`);
    return arbitratePlan({ ...run, planReviewer: firstObjector });
  }
  return { ...retry(run, "plan-review", report, "plan_fix"), planReviewer: firstObjector };
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
  const snap = snapshotPlan(run);
  const outcome = await agentStep(
    run, agent, "plan-fix",
    renderPrompt("plan-fix", { requirement: run.requirement, testPattern: cfg.testPattern }),
    { kind: "write", reset: async () => { await discardChanges(worktreeDir(run.id)); restorePlan(run, snap); } },
  );
  const { r, agent: actual } = outcome;
  await discardChanges(worktreeDir(run.id)); // 只允許改 .flow/
  if (!r.ok) {
    restorePlan(run, snap);
    return retry(run, "plan-fix", `${feedback}\n\n（上次修改時 Agent 執行失敗：${r.summary}）`, "plan_fix");
  }
  const ordered = validatePlan(run);
  if (typeof ordered === "string") {
    restorePlan(run, snap);
    return retry(run, "plan-fix", `${feedback}\n\n另外，修改後的計畫沒有通過格式檢查，已還原：\n${ordered}`, "plan_fix");
  }
  const handoffError = finishHandoff(run, outcome, "writer");
  if (handoffError) {
    restorePlan(run, snap);
    return retry(run, "plan-fix", handoffError, "plan_fix");
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
    const snap = snapshotPlan(run);
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
      info(run, `   ⏸️  ${arbiter} 未產生有效裁決：${reason}`);
      return { ...run, stage: "paused", pausedStage: "plan_review", pauseReason: `${arbiter} 仲裁未產生有效裁決：${reason}` };
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
  return { ...run, stage: "failed", failedStage: "plan_review", failureReason: `${summary}，需要人工決定（見 plan.md 的仲裁紀錄）` };
}

function planTamperedMessage(files: string[]): string {
  return `計畫定案後不可修改規格與計畫檔，已還原你的變更：${files.map((f) => `.flow/${f}`).join(", ")}。若認為規格或驗收條件有誤，請寫進 .flow/handoff-response.json 的 newIssues。`;
}

async function implementStage(run: FlowRun): Promise<FlowRun> {
  const tasks = loadOrderedTasks(run);
  const task = tasks[run.taskIndex];
  if (!task) {
    info(run, "✅ 所有任務完成");
    return to(run, "verify");
  }
  const cfg = loadRepoConfig();
  const repo = worktreeDir(run.id);
  const testRe = new RegExp(cfg.testPattern);
  const testCmd = `${cfg.install} && ${cfg.test}`;
  const progress = `${run.taskIndex + 1}/${tasks.length} ${task.id} ${task.title}`;
  const taskJson = JSON.stringify(task, null, 2);
  const acceptance = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!acceptance.ok) throw new Error(acceptance.error);
  const acceptanceJson = JSON.stringify(taskAcceptance(task, acceptance.data), null, 2);
  if (run.taskPhase === "review") return taskReviewStep(run, task, progress, taskJson, acceptanceJson);
  if (run.taskPhase === "verify") return taskVerifyStep(run, task, progress);
  if (run.taskPhase === "fix") return taskFixStep(run, task, progress);
  const agents = taskAgents(run.cycle, run.taskIndex, cfg.tddSplit, run.id);

  // ── 紅燈：只寫測試，而且測試必須失敗 ──
  if (run.taskPhase === "tests") {
    const key = `${task.id}:tests`;
    info(run, `🧪 [${progress}] 撰寫測試（${agents.tests}）`);
    const before = await headCommit(repo);
    const snap = snapshotPlan(run, LOCKED_FILES);
    const outcome = await agentStep(
      run, agents.tests, `${task.id}-tests`,
      renderPrompt("implement-tests", { task: taskJson, acceptance: acceptanceJson, testPattern: cfg.testPattern, testCmd }),
      { kind: "write", reset: async () => { await resetTo(repo, before); restorePlan(run, snap); } },
    );
    const { r, agent: testsAuthor } = outcome;
    const tampered = restorePlan(run, snap);
    if (!r.ok) {
      await resetTo(repo, before);
      return retry(run, key, `Agent 執行失敗：${r.summary}`, "implement");
    }
    if (tampered.length) {
      await resetTo(repo, before);
      return retry(run, key, planTamperedMessage(tampered), "implement");
    }
    const commit = await commitAll(repo, `test(${task.id}): ${task.title} [${testsAuthor}]`);
    if (!commit) return retry(run, key, "沒有任何檔案變更，這個階段必須撰寫測試。", "implement");
    const changed = await changedFiles(repo, before, commit);
    if (!changed.some((f) => testRe.test(f))) {
      await resetTo(repo, before);
      return retry(run, key, `沒有新增或修改任何符合 /${cfg.testPattern}/ 的測試檔。`, "implement");
    }
    const red = await runCommand(target(run, `${task.id}-red`, CMD_AGENT), testCmd);
    if (red.ok) {
      await resetTo(repo, before);
      return retry(run, key, "測試在功能尚未實作前就全部通過，代表測試沒有驗證到新行為。請撰寫會因功能尚未實作而失敗的測試。", "implement");
    }
    const handoffError = finishHandoff(run, outcome, "writer");
    if (handoffError) {
      await resetTo(repo, before);
      return retry(run, key, handoffError, "implement");
    }
    writeFileSync(flowFile(run, "red-output.txt"), red.output);
    info(run, `🔴 [${progress}] 測試如預期失敗`);
    return { ...succeed(run, key, "implement"), taskPhase: "code", taskBase: before, testsCommit: commit, lastTestsAuthor: testsAuthor };
  }

  // ── 綠燈：實作到測試通過，而且不可動測試 ──
  const key = `${task.id}:code`;
  const testsCommit = run.testsCommit;
  if (!testsCommit) throw new Error("缺少 testsCommit，狀態不一致");
  info(run, `🛠️  [${progress}] 實作（${agents.code}，測試由 ${run.lastTestsAuthor ?? agents.tests} 撰寫）`);
  const redOutput = existsSync(flowFile(run, "red-output.txt")) ? readFileSync(flowFile(run, "red-output.txt"), "utf8") : "";
  const snap = snapshotPlan(run, LOCKED_FILES);
  const outcome = await agentStep(
    run, agents.code, `${task.id}-code`,
    renderPrompt("implement-code", { task: taskJson, acceptance: acceptanceJson, testCmd, redOutput: tail(redOutput, 3000) }),
    { kind: "write", reset: async () => { await resetTo(repo, testsCommit); restorePlan(run, snap); } },
  );
  const { r, agent: codeAuthor } = outcome;
  const tampered = restorePlan(run, snap);
  if (!r.ok) return retry(run, key, `Agent 執行失敗：${r.summary}`, "implement");
  if (tampered.length) {
    await resetTo(repo, testsCommit);
    return retry(run, key, planTamperedMessage(tampered), "implement");
  }
  await commitAll(repo, `feat(${task.id}): ${task.title} [${codeAuthor}]`);
  const touched = (await changedFiles(repo, testsCommit, await headCommit(repo))).filter((f) => testRe.test(f));
  if (touched.length) {
    await resetTo(repo, testsCommit);
    return retry(run, key, `實作階段不可修改測試檔，已還原你的變更：${touched.join(", ")}`, "implement");
  }
  const green = await runCommand(target(run, `${task.id}-green`, CMD_AGENT), testCmd);
  if (!green.ok) {
    info(run, `   ✗ 測試仍未通過${logHint(run, green.seq)}`);
    return retry(run, key, `測試仍未通過：\n\n\`\`\`\n${tail(green.output)}\n\`\`\``, "implement");
  }
  const handoffError = finishHandoff(run, outcome, "writer");
  if (handoffError) {
    await resetTo(repo, testsCommit);
    return retry(run, key, handoffError, "implement");
  }
  info(run, `🟢 [${progress}] 測試通過`);
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
    // 未結交接事項可能屬於後面的任務，由最後的整體審查把關
    gate: false,
    runKey: `${task.id}:review-run`,
    backTo: "implement",
  });
  if ("run" in result) return result.run;
  const reviewed = succeed(run, `${task.id}:review-run`, "implement");
  if (!result.objector) return { ...succeed(reviewed, key, "implement"), taskPhase: "verify" };
  return {
    ...retry(reviewed, key, `任務審查要求修改：\n\n${result.issues.join("\n\n")}`, "implement"),
    taskPhase: "fix",
    fixSource: "review",
    lastReviewer: result.objector,
  };
}

// ── 任務驗證：通過才進入下一個任務 ──
async function taskVerifyStep(run: FlowRun, task: TaskItem, progress: string): Promise<FlowRun> {
  const key = `${task.id}:verify`;
  info(run, `🔍 [${progress}] 執行驗證`);
  const report = await runChecks(run, `${task.id}-`);
  if (report) return { ...retry(run, key, report, "implement"), taskPhase: "fix", fixSource: "verify" };
  info(run, `✅ [${progress}] 完成`);
  return {
    ...succeed(run, key, "implement"),
    taskIndex: run.taskIndex + 1,
    taskPhase: "tests",
    taskBase: undefined,
    testsCommit: undefined,
    lastTestsAuthor: undefined,
  };
}

// ── 任務修正：修完重新審查、驗證 ──
async function taskFixStep(run: FlowRun, task: TaskItem, progress: string): Promise<FlowRun> {
  const result = await applyFix(run, {
    seed: `${run.id}:fix:${task.id}:${run.attempts[`${task.id}:review`] ?? 0}`,
    label: `[${progress}] `,
    step: `${task.id}-fix`,
    commitScope: `fix(${task.id})`,
    key: `${task.id}:fix`,
    backTo: "implement",
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
  return { ...retry(run, "verify", report, "fix"), fixSource: "verify" };
}

/** 修正驗證錯誤或審查意見；成功時回傳實際修正者，未通過時回傳重試後的 run */
async function applyFix(
  run: FlowRun,
  opts: { seed: string; label: string; step: string; commitScope: string; key: string; backTo: Stage },
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
  const again = (reason: string) => ({ run: retry(run, opts.key, reason, opts.backTo) });
  if (!r.ok) return again(`${feedback}\n\n（上次修正時 Agent 執行失敗：${r.summary}）`);
  if (tampered.length) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外：${planTamperedMessage(tampered)}`);
  }
  await commitAll(repo, `${opts.commitScope}: ${why} [${actual}]`);
  const testRe = new RegExp(cfg.testPattern);
  const deleted = (await changedFiles(repo, before, await headCommit(repo), "D")).filter((f) => testRe.test(f));
  if (deleted.length) {
    await resetTo(repo, before);
    return again(`${feedback}\n\n另外：不可刪除測試檔來讓檢查通過，已還原：${deleted.join(", ")}`);
  }
  const handoffError = finishHandoff(run, outcome, "writer");
  if (handoffError) {
    await resetTo(repo, before);
    return again(handoffError);
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
  return { ...to(run, "verify"), lastWriter: result.agent };
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
    gate: boolean; runKey: string; backTo: Stage; testAuthor?: string;
  },
): Promise<{ run: FlowRun } | { objector?: string; issues: string[] }> {
  const cfg = loadRepoConfig();
  const repo = worktreeDir(run.id);
  const panel = reviewers(run.cycle, run.lastWriter, cfg.reviewQuorum, opts.seed, opts.testAuthor);
  writeFileSync(flowFile(run, "diff.patch"), await git(repo, "diff", `${opts.base}...HEAD`));
  const authors = [...new Set((await git(repo, "log", "--format=%s", `${opts.base}..HEAD`)).match(/\[[^\]]+\]$/gm) ?? [])]
    .map((s) => s.slice(1, -1));

  const issues: string[] = [];
  let objector: string | undefined;
  for (const [slot, reviewer] of panel.entries()) {
    info(run, `👀 ${opts.label}（${reviewer}）`);
    rmSync(flowFile(run, "review.json"), { force: true });
    const snap = snapshotPlan(run, LOCKED_FILES);
    const outcome = await agentStep(run, reviewer, opts.step, opts.prompt(reviewer, authors.join("、") || "未知"), {
      kind: "review", slot, reset: async () => { await discardChanges(repo); restorePlan(run, snap); },
    });
    const { r } = outcome;
    await discardChanges(repo); // 審查者不可改程式碼
    const tampered = restorePlan(run, snap); // .flow/ 不受 git 管理，要另外還原
    if (tampered.length) info(run, `   ↩️  已還原審查者修改的檔案：${tampered.join(", ")}`);
    if (!r.ok) return { run: retry(run, opts.runKey, `Agent 執行失敗：${r.summary}`, opts.backTo) };
    const review = readJsonFile(flowFile(run, "review.json"), ConsistentReviewResult);
    if (!review.ok) return { run: retry(run, opts.runKey, review.error, opts.backTo) };
    const gate = opts.gate ? { target: "code" as const, verdict: review.data.verdict } : undefined;
    const handoffError = finishHandoff(run, outcome, "reviewer", gate);
    if (handoffError) return { run: retry(run, opts.runKey, handoffError, opts.backTo) };
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
  return { objector, issues };
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
  if (!result.objector) return succeed(run, "review", "pr");
  return {
    ...retry(run, "review", `程式碼審查要求修改：\n\n${result.issues.join("\n\n")}`, "fix"),
    fixSource: "review",
    lastReviewer: result.objector,
  };
}

async function prStage(run: FlowRun): Promise<FlowRun> {
  const pending = openActions(readHandoff(run.id));
  if (pending.length) return { ...run, stage: "failed", failedStage: "pr", failureReason: `仍有未結交接事項：${pending.map((item) => item.id).join("、")}` };
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
  for (;;) {
    if (["done", "failed", "awaiting_approval", "paused"].includes(run.stage)) return run;
    const stage = run.stage as ActiveStage;
    const runs = agentRuns(run.id);
    if (runs >= run.maxAgentRuns) {
      return saveRun({
        ...run,
        stage: "failed",
        failedStage: stage,
        failureReason: `已執行 agent ${runs} 次，達到上限 ${run.maxAgentRuns}（可用 resume --max-agent-runs 調高）`,
      });
    }
    try {
      run = saveRun(await STAGES[stage](run));
    } catch (err) {
      if (err instanceof QuotaPause) {
        info(run, `⏸️  暫停：${err.message}`);
        return saveRun({ ...run, stage: "paused", pausedStage: stage, pauseReason: err.message });
      }
      return saveRun({ ...run, stage: "failed", failedStage: stage, failureReason: (err as Error).message });
    }
  }
}
