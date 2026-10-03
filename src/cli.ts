#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { MIN_ATTEMPTS, config } from "./config.js";
import { advance, iterateRun, loadRepoConfig, replanRun } from "./engine.js";
import { exec } from "./proc.js";
import { probeAgent, resolveAgent, runCommand } from "./runner.js";
import { addWorktree, git } from "./git.js";
import { cleanableRuns, cleanRun } from "./cleanup.js";
import { describeDetected, detectProjectDefaults } from "./detect.js";
import { CMD_AGENT, listLogs, localTime, logMark, nextLogFile, renderLog } from "./logs.js";
import { confirmationsPath, flowDir, laneId, logDir, projectRoot, worktreeDir } from "./paths.js";
import { ModelStage, ModelStrength, OrderedTaskList, StopAfterStage, type FlowRun, type StopAfterStage as StopAfterStageType, type TaskItem } from "./schemas.js";
import { computeInsights, failureLabel, retryLabel } from "./insights.js";
import { computeUsageInsights } from "./usageInsights.js";
import { computeStats, formatDuration } from "./stats.js";
import { agentRuns, getRun, listRetries, listRuns, listSubstitutions, listUsage, saveRun, usageByAgent, usageByModelStage, usageByStage, usageByStrength, usageByTask, type UsageSummary } from "./store.js";
import { confirmationLines, confirmationTasks } from "./tasks.js";
import { padDisplay, readJsonFile, type JsonResult } from "./util.js";
import { openActions, readHandoff } from "./handoff.js";
import { stopReport } from "./stopReport.js";
import { dumpRun, restoreRun } from "./dump.js";
import { runSetup, SETUP_ADAPTERS, type Detected } from "./setup.js";
import { addAgent, readRawConfig, removeAgent, setAgent, setCycle, writeRawConfig, type Edit } from "./agentConfig.js";
import { addModel, removeModel, setModelMode, setModelStrength, setStageStrength } from "./modelConfig.js";
import { DEFAULT_STAGE_STRENGTH, effectiveStageStrengths, validateAdaptiveConfig } from "./modelSelection.js";
import { probeModel } from "./modelProbe.js";

const cacheNote = (c: UsageSummary) =>
  c.cacheReadTokens || c.cacheWriteTokens ? `（含 cache 讀 ${c.cacheReadTokens}、寫 ${c.cacheWriteTokens}）` : "";

function printUsage(title: string, rows: Array<[string, UsageSummary]>): void {
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const [key, c] of rows) {
    const value = c.reportedRuns ? `輸入 ${c.inputTokens}${cacheNote(c)}、輸出 ${c.outputTokens}、合計 ${c.tokens} tokens` : "未回報或回報狀態不明";
    console.log(`  ${key}: ${value}；${c.runs} 次（未回報 ${c.unreportedRuns}、舊紀錄不明 ${c.legacyRuns}）`);
  }
}

function positiveInt(text: string, flag: string, min = 1): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} 必須是不小於 ${min} 的整數：${text}`);
  return n;
}

function parseStopAfter(value?: string): StopAfterStageType | undefined {
  if (value === undefined) return undefined;
  const result = StopAfterStage.safeParse(value);
  if (!result.success) throw new Error(`未知的流程停點：${value}（可用：spec、plan、implement、verify、review、pr）`);
  return result.data;
}

function mustGetRun(id: string): FlowRun {
  const run = getRun(id);
  if (!run) throw new Error(`找不到 run：${id}`);
  return run;
}

async function drive(run: FlowRun): Promise<void> {
  // Ctrl-C 會同時送給子程序（claude、測試指令），狀態已經寫在 state.json，之後可用 resume 接續
  process.once("SIGINT", () => {
    console.log("\n已中斷");
    printSummary(getRun(run.id) ?? run, true);
    process.exit(130);
  });
  printSummary(await advance(run));
}

function printSummary(run: FlowRun, interrupted = false): void {
  console.log("");
  console.log(`run      ${run.id}`);
  console.log(`階段     ${run.stage}`);
  if (run.stopAfter) console.log(`停點     ${run.stopAfter}`);
  if (run.fast) console.log("流程     fast（略過計畫審查與任務審查）");
  console.log(`用量     agent 執行 ${agentRuns(run.id)} / ${run.maxAgentRuns} 次`);
  console.log(`agent    ${run.cycle.join("、")}${run.lastWriter ? `（最後作者：${run.lastWriter}）` : ""}`);
  console.log(`分支     ${run.branch}`);
  console.log(`worktree ${worktreeDir(run.id)}`);
  if (run.prUrl) console.log(`PR       ${run.prUrl}`);
  if (run.planWriter) console.log(`計畫     作者 ${run.planWriter}${run.planReviewer ? `，最後提出意見的是 ${run.planReviewer}` : ""}`);
  if (run.stage === "failed") {
    console.log(`失敗於   ${run.failedStage ?? "?"}`);
    console.log(`原因     ${run.failureReason ?? "?"}`);
  }
  if (run.stage === "paused") {
    console.log(`暫停於   ${run.pausedStage ?? "?"}`);
    console.log(`原因     ${run.pauseReason ?? "?"}`);
  }
  const report = stopReport({
    run,
    interrupted,
    logs: listLogs(logDir(run.id)),
    read: (file) => readFileSync(file, "utf8"),
    open: openActions(readHandoff(run.id)),
    worktree: worktreeDir(run.id),
  });
  for (const line of report) console.log(line);
}

/** 決定參與的 agent：指令參數 > flow.config.json > 自動偵測已安裝的 CLI */
async function resolveCycle(flag?: string): Promise<string[]> {
  const cfg = loadRepoConfig();
  const wanted = flag ? flag.split(",").map((s) => s.trim()).filter(Boolean) : cfg.cycle;
  if (wanted) {
    for (const name of wanted) {
      if (!(await probeAgent(resolveAgent(cfg, name)))) throw new Error(`找不到可執行的 agent：${name}（可用 agentflowctl config doctor 檢查）`);
    }
    return wanted;
  }
  // 沒有內建 agent：只從 agents 裡定義的挑出已安裝的
  const defined = Object.keys(cfg.agents);
  if (!defined.length) throw new Error("還沒有設定任何 agent，請先用 agentflowctl config agent setup 互動設定，或用 config agent add <name> --adapter <adapter> 新增");
  const found: string[] = [];
  for (const name of defined) if (await probeAgent(resolveAgent(cfg, name))) found.push(name);
  if (!found.length) throw new Error(`設定的 agent（${defined.join("、")}）都沒有偵測到已安裝的 CLI，可用 agentflowctl config doctor 檢查`);
  return found;
}

/** status 任務清單中，進行中任務的標記 */
const TASK_PHASE_MARK: Record<FlowRun["taskPhase"], string> = { tests: "🧪", code: "🛠️ ", review: "👀", verify: "🔍", fix: "🩹" };

/**
 * 這個 run 需要人眼確認的任務。確認清單已寫出（計畫通過首次驗證後）就用它，draft 為 false；
 * 還沒寫出時從計畫與實作清單蒐集 kind: confirm 的任務，這些項目尚未經 validatePlan 檢查，draft 為 true。
 * ordered 可傳入呼叫端已讀過的 tasks.ordered.json，避免重複讀檔。
 */
function loadConfirmationTasks(
  id: string,
  ordered: JsonResult<TaskItem[]> = readJsonFile(join(flowDir(id), "tasks.ordered.json"), OrderedTaskList),
): { tasks: TaskItem[]; draft: boolean } {
  const newPath = confirmationsPath(id);
  const savedPath = existsSync(newPath) ? newPath : join(flowDir(id), "confirmations.json"); // 舊 run 的清單放在 .flow/
  const savedExists = existsSync(savedPath);
  const saved = savedExists ? readJsonFile(savedPath, OrderedTaskList) : undefined;
  const planned = readJsonFile(join(flowDir(id), "tasks.json"), OrderedTaskList);
  const tasks = confirmationTasks(
    saved ? (saved.ok ? saved.data : []) : undefined,
    ordered.ok ? ordered.data : [],
    planned.ok ? planned.data : [],
  );
  return { tasks, draft: !savedExists };
}

const program = new Command()
  .name("agentflowctl")
  .description("在專案資料夾內執行的 Agent 開發流程：規格 → 計畫 → TDD 實作 → 驗證 → 審查 → PR")
  .option("-v, --verbose", "執行時印出 agent 的文字、工具呼叫與專案指令（預設只印階段進度；也可在 flow.config.json 設 verbose）")
  .hook("preAction", (cmd) => {
    if (cmd.opts().verbose) config.verbose = true;
    else {
      // doctor、config agent setup 等可能在沒有專案或設定壞掉時執行；這裡讀不到就維持安靜，指令本身會回報設定錯誤
      try { config.verbose = loadRepoConfig().verbose; } catch { /* 維持預設 */ }
    }
  });

program
  .command("run")
  .description("在目前的專案建立並執行新的 flow")
  .option("--req <text>", "需求描述")
  .option("--req-file <file>", "從檔案讀取需求")
  .option("--base <branch>", "基底分支（預設為目前的分支）")
  .option("--max-agent-runs <n>", "單一 run 最多執行幾次 agent（預設：計畫定案前取 maxAgentRuns，定案後改為已執行次數加上任務數 × agentRunsPerTask；指定後不再改算）")
  .option("--max-attempts <n>", "同一關連續失敗幾次後停止（預設取 flow.config.json 的 maxAttempts，未設定為 5）")
  .option("--manual-plan", "計畫通過 AI 審查後，仍停下來等你確認", false)
  .option("--fast", "快速流程：一次 agent 呼叫寫完規格與計畫（任務最多 2 個），略過計畫審查與任務審查；計畫標出複雜度時自動改走完整流程", false)
  .option("--stop-after <stage>", "完成公開階段後暫停：spec、plan、implement、verify、review 或 pr")
  .option("--cycle <agents>", "參與的 agent，例如 claude,codex,gemini（順序不影響分工）")
  .option("--model-mode <mode>", "這次 run 的模型模式：balanced 或 adaptive")
  .action(async (opts: { req?: string; reqFile?: string; base?: string; maxAgentRuns?: string; maxAttempts?: string; manualPlan: boolean; fast: boolean; stopAfter?: string; cycle?: string; modelMode?: string }) => {
    const requirement = opts.reqFile ? readFileSync(opts.reqFile, "utf8") : opts.req;
    if (!requirement?.trim()) throw new Error("請用 --req 或 --req-file 提供需求");
    const stopAfter = parseStopAfter(opts.stopAfter);
    if (opts.manualPlan && stopAfter) throw new Error("--manual-plan 與 --stop-after 不能同時使用");
    const root = projectRoot();
    const base = opts.base ?? (await git(root, "branch", "--show-current"));
    if (!base) throw new Error("目前不在任何分支上，請用 --base 指定基底分支");
    const cycle = await resolveCycle(opts.cycle);
    const cfg = loadRepoConfig();
    const modelMode = opts.modelMode ?? cfg.modelSelection.mode;
    if (modelMode !== "balanced" && modelMode !== "adaptive") throw new Error(`未知的模型模式：${modelMode}`);
    if (modelMode === "adaptive") validateAdaptiveConfig(cfg, cycle);
    const id = `f-${Date.now().toString(36)}`;
    const branch = `flow/${id}`;
    console.log(`[${id}] 🌿 從 ${base} 建立 worktree（分支 ${branch}）`);
    await addWorktree(root, worktreeDir(id), base, branch);
    console.log(`[${id}] 🤝 參與的 agent：${cycle.join("、")}（角色隨機分配）`);
    const now = new Date().toISOString();
    // worktree 一建好就寫入紀錄：之後在任何地方中斷，都能用 resume 接續或用 clean 清掉
    const run = saveRun({
      id,
      baseBranch: base,
      branch,
      requirement: requirement.trim(),
      stage: "spec",
      stopAfter,
      autopilot: !opts.manualPlan,
      fast: opts.fast ? true : undefined,
      maxAgentRuns: opts.maxAgentRuns ? Number(opts.maxAgentRuns) : cfg.maxAgentRuns,
      maxAgentRunsExplicit: opts.maxAgentRuns ? true : undefined,
      maxAttempts: opts.maxAttempts ? positiveInt(opts.maxAttempts, "--max-attempts", MIN_ATTEMPTS) : undefined,
      cycle,
      attempts: {},
      modelMode,
      taskIndex: 0,
      taskPhase: "tests",
      createdAt: now,
      updatedAt: now,
    });
    for (const line of describeDetected(readRawConfig(configPath()), detectProjectDefaults(root))) console.log(`[${id}] ${line}`);
    // 先裝好相依套件：有些 agent 的沙箱不能連網，無法自己安裝
    const install = await runCommand({ runId: id, cwd: worktreeDir(id), logFile: nextLogFile(logDir(id), "setup", "install", CMD_AGENT), stage: "setup", step: "install" }, cfg.install);
    if (!install.ok) console.log(`[${id}] ⚠️  安裝相依套件失敗，稍後 verify 階段會再試一次（agentflowctl logs ${id} ${install.seq}）`);
    await drive(run);
  });

program
  .command("approve <id>")
  .description("核准計畫並開始實作")
  .action(async (id: string) => {
    const run = mustGetRun(id);
    if (run.stage !== "awaiting_approval") throw new Error(`run 目前在 ${run.stage}，不需要核准`);
    await drive(saveRun({ ...run, stage: "implement" }));
  });

program
  .command("replan <id>")
  .description("人工介入計畫：補充意見或手改 .flow/ 計畫檔後重做計畫（只修改相關部分，不重寫整份）")
  .option("--note <文字>", "補充意見，交給計畫修訂者只改相關的任務與段落")
  .option("--note-file <路徑>", "從檔案讀補充意見")
  .option("--no-review", "改完直接定案，不再送審")
  .action(async (id: string, opts: { note?: string; noteFile?: string; review: boolean }) => {
    if (opts.note && opts.noteFile) throw new Error("--note 與 --note-file 只能擇一");
    const note = opts.noteFile ? readFileSync(opts.noteFile, "utf8") : opts.note;
    await drive(saveRun(replanRun(mustGetRun(id), { note, noReview: !opts.review })));
  });

program
  .command("iterate <id>")
  .description("在已完成 run 的同一個 worktree 開第二輪：帶入補充需求，從 spec 重來（程式碼與 PR 沿用）")
  .option("--req <text>", "第二輪的補充需求")
  .option("--req-file <file>", "從檔案讀取補充需求")
  .option("--max-agent-runs <n>", "這一輪最多再執行幾次 agent（預設取 flow.config.json 的 maxAgentRuns，從目前已執行的次數起算）")
  .action(async (id: string, opts: { req?: string; reqFile?: string; maxAgentRuns?: string }) => {
    const requirement = opts.reqFile ? readFileSync(opts.reqFile, "utf8") : opts.req;
    if (!requirement?.trim()) throw new Error("請用 --req 或 --req-file 提供第二輪的補充需求");
    const run = mustGetRun(id);
    if (run.stage !== "done") throw new Error(`run 目前在 ${run.stage}，只有已完成（done）的 run 可以開下一輪`);
    if (run.prUrl) {
      // 讀不到狀態（沒有 gh、沒登入）就略過檢查；PR 已合併時，在同一分支追加的 commit 不會進到 PR
      const state = await exec("gh", ["pr", "view", run.prUrl, "--json", "state", "--jq", ".state"], { cwd: worktreeDir(id) }).catch(() => undefined);
      if (state?.code === 0 && state.stdout.trim() === "MERGED") {
        throw new Error(`PR 已合併（${run.prUrl}），無法再更新；請用 agentflowctl run 以最新的 ${run.baseBranch} 開新的 run`);
      }
    }
    if (run.modelMode === "adaptive") validateAdaptiveConfig(loadRepoConfig(), run.cycle);
    const next = await iterateRun(run, { requirement, maxAgentRuns: opts.maxAgentRuns ? Number(opts.maxAgentRuns) : undefined });
    console.log(`[${id}] 🔁 開始第 ${next.round} 輪，沿用 worktree 與分支 ${next.branch}`);
    await drive(saveRun(next));
  });

program
  .command("resume <id>")
  .description("從暫停、中斷或失敗的階段接續")
  .option("--max-agent-runs <n>", "調整 agent 執行次數上限")
  .option("--max-attempts <n>", "調整同一關連續失敗的上限")
  .action(async (id: string, opts: { maxAgentRuns?: string; maxAttempts?: string }) => {
    let run = mustGetRun(id);
    if (run.modelMode === "adaptive") validateAdaptiveConfig(loadRepoConfig(), run.cycle);
    if (opts.maxAgentRuns) run = { ...run, maxAgentRuns: Number(opts.maxAgentRuns), maxAgentRunsExplicit: true };
    if (opts.maxAttempts) run = { ...run, maxAttempts: positiveInt(opts.maxAttempts, "--max-attempts", MIN_ATTEMPTS) };
    if (run.stage === "paused") {
      run = { ...run, stage: run.pausedStage ?? "spec", pausedStage: undefined, pauseReason: undefined };
    }
    if (run.stage === "failed") {
      run = { ...run, stage: run.failedStage ?? "spec", attempts: {}, modelRetryAttempts: {}, failedStage: undefined, failureReason: undefined, failureCategory: undefined };
    }
    await drive(saveRun(run));
  });

program
  .command("cancel <id>")
  .description("標記 run 為失敗（執行中的 run 請直接在該終端機按 Ctrl-C）")
  .action((id: string) => {
    const run = mustGetRun(id);
    saveRun({ ...run, stage: "failed", failedStage: run.stage, failureCategory: "cancelled", failureReason: "使用者取消" });
    console.log(`已取消 ${id}`);
  });

program
  .command("clean [id]")
  .description("移除 run 的 worktree 與紀錄（分支會保留）；--all 清掉所有已結束的 run 與中斷留下的孤兒 worktree")
  .option("--all", "清除所有 done、failed 的 run，以及沒有紀錄的 worktree；進行中、暫停、等待核准的不動", false)
  .action(async (id: string | undefined, opts: { all: boolean }) => {
    if (opts.all === Boolean(id)) throw new Error("請指定 run id，或使用 --all（兩者擇一）");
    if (id) {
      if (!(await cleanRun(id))) throw new Error(`找不到 run：${id}`);
      console.log(`已清除 ${id}，分支仍保留，不需要時可用 git branch -D 刪除`);
      return;
    }
    const targets = cleanableRuns();
    if (!targets.length) {
      await git(projectRoot(), "worktree", "prune");
      console.log("沒有可清除的 run");
      return;
    }
    for (const t of targets) {
      await cleanRun(t.id);
      console.log(`已清除 ${t.id}（${t.stage ?? "沒有紀錄，可能是建立時中斷"}）`);
    }
    console.log(`\n共清除 ${targets.length} 個，分支仍保留，不需要時可用 git branch -D 刪除`);
  });

program
  .command("status <id>")
  .description("顯示 run 狀態與任務進度")
  .action((id: string) => {
    const run = mustGetRun(id);
    printSummary(run);
    const byAgent = usageByAgent(id);
    if (Object.keys(byAgent).length) {
      console.log("\n各 agent 用量");
      for (const [agent, c] of Object.entries(byAgent)) {
        console.log(`  ${agent.padEnd(10)} ${String(c.runs).padStart(3)} 次  ${String(c.tokens).padStart(9)} 已回報 tokens${cacheNote(c)}（未回報 ${c.unreportedRuns}、舊紀錄不明 ${c.legacyRuns}${c.legacyTokens ? `，原始數字 ${c.legacyTokens} tokens` : ""}）`);
      }
    }
    const byStage = usageByStage(id);
    const stageOrder = [...Object.keys(DEFAULT_STAGE_STRENGTH), "其他"];
    printUsage("各階段用量（同一步驟的所有任務合計）", Object.entries(byStage).sort(([a], [b]) => stageOrder.indexOf(a) - stageOrder.indexOf(b)));
    const taskNo = (key: string) => /^T-(\d+)$/.exec(key) ? Number(key.slice(2)) : Infinity;
    printUsage("各任務用量（寫測試、實作、任務審查、任務修正）", Object.entries(usageByTask(id)).sort(([a], [b]) => taskNo(a) - taskNo(b)));
    printUsage("各模型與步驟用量（只加總明確回報）", Object.entries(usageByModelStage(id)));
    const byStrength = usageByStrength(id);
    const reportedTotal = Object.values(byStrength).reduce((sum, entry) => sum + entry.tokens, 0);
    if (Object.keys(byStrength).length) {
      console.log("\n模型強度用量（占比只計入明確回報）");
      for (const strength of ["low", "medium", "high", "未知"]) {
        const entry = byStrength[strength];
        if (!entry) continue;
        const share = reportedTotal ? `${(entry.tokens / reportedTotal * 100).toFixed(1)}%` : "無法計算";
        console.log(`  ${strength}: ${entry.tokens} tokens，占比 ${share}，呼叫 ${entry.runs} 次（未回報 ${entry.unreportedRuns}、舊紀錄不明 ${entry.legacyRuns}）`);
      }
      console.log(`  高強度呼叫：${byStrength.high?.runs ?? 0} 次`);
    }
    const subs = listSubstitutions(id);
    if (subs.length) {
      console.log("\n代打紀錄");
      for (const sub of subs) console.log(`  ${sub.at.slice(0, 16)}  ${sub.step.padEnd(14)} ${sub.planned} → ${sub.actual}${sub.note ? `（${sub.note}）` : ""}`);
    }
    const retries = listRetries(id);
    if (retries.length) {
      console.log("\n重試紀錄");
      for (const r of retries) {
        console.log(`  ${r.key.padEnd(19)}  ${retryLabel(r.category)}${r.final ? "（達上限）" : `（第 ${r.attempt} 次）`}`);
      }
    }
    const tasks = readJsonFile(join(flowDir(id), "tasks.ordered.json"), OrderedTaskList);
    if (tasks.ok && tasks.data.some((t) => t.kind !== "confirm")) {
      console.log("\n任務");
      const merged = new Set(run.doneTasks ?? []);
      tasks.data.forEach((t, i) => {
        if (t.kind === "confirm") return;
        // 平行執行中的任務各有自己的車道狀態；順序執行時看 taskIndex
        const lane = getRun(laneId(run.id, t.id));
        const active = lane ? lane.stage === "implement" : i === run.taskIndex && run.stage === "implement";
        const phase = lane?.taskPhase ?? run.taskPhase;
        const mark = i < run.taskIndex || merged.has(t.id) ? "✅" : active ? TASK_PHASE_MARK[phase] : lane?.stage === "paused" ? "⏸️ " : "⬜";
        console.log(`  ${mark} ${t.id} ${t.title}${lane && !merged.has(t.id) ? "（平行）" : ""}`);
      });
    }
    const confirm = loadConfirmationTasks(id, tasks);
    if (confirm.tasks.length) console.log(`\n${confirmationLines(confirm.tasks, confirm.draft).join("\n")}`);
  });

program
  .command("confirmations <id>")
  .description("只列出這個 run 需要人眼確認的任務")
  .action((id: string) => {
    mustGetRun(id);
    const confirm = loadConfirmationTasks(id);
    console.log(confirmationLines(confirm.tasks, confirm.draft).join("\n"));
  });

// 除錯用，不列在 --help 也不寫進 README
program
  .command("dump <id> [outDir]", { hidden: true })
  .description("把單一 run 的除錯資料打包到目錄")
  .action(async (id: string, outDir?: string) => {
    mustGetRun(id);
    const dest = outDir ?? join(projectRoot(), ".agentflowctl", "dumps", `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await dumpRun(id, dest);
    console.log(`✅ 已輸出到 ${dest}`);
  });

program
  .command("restore <dumpDir>", { hidden: true })
  .description("把 dump 的資料還原成可以 resume 的 run（沿用原 id，用既有分支重建 worktree）")
  .action(async (dumpDir: string) => {
    const run = await restoreRun(dumpDir);
    console.log(`✅ 已還原 ${run.id}（階段 ${run.stage}，分支 ${run.branch}）；worktree 不含 node_modules，接續前請先在裡面安裝相依套件，再用 agentflowctl resume ${run.id}`);
  });

// ───────────── agent 管理：讀寫 flow.config.json 的 agents 與 cycle ─────────────

const configPath = () => join(projectRoot(), "flow.config.json");
const collect = (value: string, prev: string[] = []) => [...prev, value];
const parseStrength = (value: string) => {
  const result = ModelStrength.safeParse(value);
  if (!result.success) throw new Error(`未知的模型強度：${value}（請使用 low、medium 或 high）`);
  return result.data;
};
const parseModelStage = (value: string) => {
  const result = ModelStage.safeParse(value);
  if (!result.success) throw new Error(`未知的 LLM 階段：${value}`);
  return result.data;
};

function applyEdit(edit: (cfg: Record<string, unknown>) => Edit, done: string): void {
  const before = readRawConfig(configPath());
  const { cfg, changes } = edit(before);
  writeRawConfig(configPath(), cfg);
  console.log(`✅ ${done}（${configPath()}）`);
  for (const c of changes) console.log(`   ↳ ${c}`);
  if (JSON.stringify(before.cycle) !== JSON.stringify(cfg.cycle)) {
    console.log("   已建立的 run 會沿用建立時參與的 agent，不受影響");
  }
}

const configCmd = program.command("config").description("設定：agent、模型、選模策略與環境檢查（寫入 flow.config.json）");
const agent = configCmd.command("agent").description("管理 agent 與 adapter 設定");

agent
  .command("list")
  .description("列出設定的 agent、是否已安裝、是否參與")
  .action(async () => {
    const cfg = loadRepoConfig();
    const cycle = await resolveCycle().catch(() => cfg.cycle ?? []);
    const names = Object.keys(cfg.agents);
    if (!names.length) console.log("還沒有設定任何 agent，請用 config agent setup 互動設定，或用 config agent add <name> --adapter <adapter> 新增");
    for (const name of names) {
      const def = resolveAgent(cfg, name);
      const ok = await probeAgent(def);
      const pos = cycle.indexOf(name);
      const detail = [
        `adapter=${def.adapter}`,
        def.model && `model=${def.model}`,
        def.effort && `effort=${def.effort}`,
        def.extraArgs.length && `extraArgs=${def.extraArgs.join(" ")}`,
        def.command && `command=${def.command.join(" ")}`,
      ].filter(Boolean);
      console.log(`${ok ? "✅" : "❌"} ${name.padEnd(14)} ${pos >= 0 ? "參與" : "不參與"}  ${detail.join(" ")}`);
    }
    console.log(`
參與的 agent：${cycle.length ? cycle.join("、") : "（沒有可用的 agent）"}${cfg.cycle ? "" : "（自動偵測）"}`);
  });

agent
  .command("add <name> [command...]")
  .description("新增 agent；command adapter 的指令寫在 -- 後面")
  .requiredOption("--adapter <adapter>", "claude、codex、gemini 或 command")
  .option("--model <model>", "模型名稱")
  .option("--effort <effort>", "推理強度，只有 claude 與 codex 支援，例如 low、medium、high")
  .option("--extra-arg <arg>", "額外參數，可重複；以 - 開頭時寫成 --extra-arg=--sandbox", collect)
  .option("--model-probe-arg <arg>", "自訂 command 的模型探測命令參數，可重複", collect)
  .action((name: string, command: string[], opts: { adapter: string; model?: string; effort?: string; extraArg?: string[]; modelProbeArg?: string[] }) => {
    applyEdit(
      (cfg) => addAgent(cfg, name, { adapter: opts.adapter, model: opts.model, effort: opts.effort, extraArgs: opts.extraArg, modelProbe: opts.modelProbeArg, command: command.length ? command : undefined }),
      `已新增 ${name}；要讓它參與請用 config agent cycle`,
    );
  });

agent
  .command("set <name> [command...]")
  .description("修改 agent；更換 adapter 時會清掉舊 adapter 的 model、extraArgs、command")
  .option("--adapter <adapter>", "claude、codex、gemini 或 command")
  .option("--model <model>", "模型名稱")
  .option("--effort <effort>", "推理強度，只有 claude 與 codex 支援，例如 low、medium、high")
  .option("--extra-arg <arg>", "額外參數，可重複，會整個取代原本的設定", collect)
  .option("--model-probe-arg <arg>", "自訂 command 的模型探測命令參數，可重複，會整個取代", collect)
  .action((name: string, command: string[], opts: { adapter?: string; model?: string; effort?: string; extraArg?: string[]; modelProbeArg?: string[] }) => {
    applyEdit(
      (cfg) => setAgent(cfg, name, { adapter: opts.adapter, model: opts.model, effort: opts.effort, extraArgs: opts.extraArg, modelProbe: opts.modelProbeArg, command: command.length ? command : undefined }),
      `已更新 ${name}`,
    );
  });

agent
  .command("remove <name>")
  .description("刪除 agent，一併從參與的 agent 移除")
  .action((name: string) => applyEdit((cfg) => removeAgent(cfg, name), `已移除 ${name}`));

agent
  .command("cycle [names]")
  .description("顯示參與的 agent，或用逗號分隔設定新的名單")
  .action(async (names?: string) => {
    if (!names) {
      const cfg = loadRepoConfig();
      console.log(`${(await resolveCycle()).join("、")}${cfg.cycle ? "" : "（自動偵測）"}`);
      return;
    }
    const list = names.split(",").map((s) => s.trim()).filter(Boolean);
    applyEdit((cfg) => setCycle(cfg, list), `參與的 agent 設為 ${list.join("、")}`);
    const cfg = loadRepoConfig();
    for (const n of list) {
      if (!(await probeAgent(resolveAgent(cfg, n)))) console.log(`⚠️  ${n} 目前找不到可執行的 CLI，run 會失敗，請先安裝或用 config agent set 修正`);
    }
  });

agent
  .command("setup")
  .description("互動式設定：偵測本機已安裝的 agent CLI，逐一選擇要不要加入並設定參與的 agent")
  .action(async () => {
    if (!stdin.isTTY) throw new Error("config agent setup 需要互動式終端機，請改用 config agent add");
    const detected: Detected = {};
    for (const a of SETUP_ADAPTERS) detected[a] = await probeAgent({ adapter: a, extraArgs: [] });
    let configured: Record<string, boolean> | undefined;
    try {
      const cfg = loadRepoConfig();
      configured = {};
      for (const name of Object.keys(cfg.agents)) configured[name] = await probeAgent(resolveAgent(cfg, name));
    } catch {
      // 設定檔不合法時照樣進精靈，只是不列出已設定的 agent
    }
    const rl = createInterface({ input: stdin, output: stdout });
    let edit: Edit | null;
    try {
      edit = await runSetup(readRawConfig(configPath()), { ask: (q) => rl.question(q), detected, configured, log: (l) => console.log(l) });
    } finally {
      rl.close();
    }
    if (!edit) return;
    const result = edit;
    applyEdit(() => result, "設定完成");
    console.log("");
    await doctor();
  });

// ───────────── 模型清單（config agent model）與選模策略（config selection） ─────────────

const model = agent.command("model").description("管理某個 agent 的模型清單與強度，並檢查目前帳號能否呼叫模型");
const selection = configCmd.command("selection").description("選模策略：模型模式與各階段的最低強度");

model.command("add <agent> <name>")
  .requiredOption("--strength <strength>", "low、medium 或 high")
  .option("--effort <effort>", "這個模型呼叫時的推理強度，只有 claude 與 codex 支援")
  .action(async (agent: string, name: string, opts: { strength: string; effort?: string }) => {
    const strength = parseStrength(opts.strength);
    const before = readRawConfig(configPath());
    const cfg = loadRepoConfig();
    const def = cfg.agents[agent];
    if (!def) throw new Error(`未定義的 agent：${agent}`);
    const next = addModel(before, agent, name, strength, opts.effort);
    console.log("模型檢查會送出最短請求，可能耗用少量 token。");
    const checked = await probeModel(def, name, undefined, opts.effort);
    if (checked.status !== "ok") throw new Error(`${agent} 的模型 ${name} 未加入：${checked.reason}`);
    writeRawConfig(configPath(), next);
    console.log(`✅ 已新增 ${agent} 的模型 ${name}（${strength}${opts.effort ? `，effort ${opts.effort}` : ""}）${checked.resolvedModel ? ` → ${checked.resolvedModel}` : ""}${def.adapter === "command" ? "（由自訂探測命令回報）" : ""}；探測可能耗用少量 token`);
  });

model.command("set <agent> <name>")
  .option("--strength <strength>", "low、medium 或 high")
  .option("--effort <effort>", "推理強度；填 none 清除")
  .option("--at <strength>", "同名模型有多筆強度時，指定要修改哪一筆（目前的強度）")
  .action((agent: string, name: string, opts: { strength?: string; effort?: string; at?: string }) => {
    const effort = opts.effort === "none" ? null : opts.effort;
    writeRawConfig(configPath(), setModelStrength(readRawConfig(configPath()), agent, name, opts.strength === undefined ? undefined : parseStrength(opts.strength), effort, opts.at === undefined ? undefined : parseStrength(opts.at)));
    const changed = [opts.strength !== undefined && `強度設為 ${opts.strength}`, opts.effort !== undefined && (effort === null ? "已清除 effort" : `effort 設為 ${opts.effort}`)].filter(Boolean).join("、");
    console.log(`✅ 已將 ${agent} 的模型 ${name} ${changed}；此指令不重驗可用性`);
  });

model.command("remove <agent> <name>")
  .option("--at <strength>", "同名模型有多筆強度時，指定要移除哪一筆")
  .action((agent: string, name: string, opts: { at?: string }) => {
  writeRawConfig(configPath(), removeModel(readRawConfig(configPath()), agent, name, opts.at === undefined ? undefined : parseStrength(opts.at)));
  console.log(`✅ 已移除 ${agent} 的模型 ${name}`);
});

model.command("list [agent]").action((agent?: string) => {
  const cfg = loadRepoConfig();
  const names = agent ? [agent] : Object.keys(cfg.agents);
  for (const name of names) {
    const def = cfg.agents[name];
    if (!def) throw new Error(`未定義的 agent：${name}`);
    console.log(`${name}（${def.adapter}）`);
    for (const item of def.models ?? []) console.log(`  ${item.name}  ${item.strength}${item.effort ? `  effort=${item.effort}` : ""}`);
    if (!def.models?.length) console.log("  尚未設定模型");
  }
  console.log("清單只顯示設定內容；要確認當前帳號是否可用，請執行 config agent model check。");
});

model.command("check [agent]").action(async (agent?: string) => {
  const cfg = loadRepoConfig();
  const names = agent ? [agent] : Object.keys(cfg.agents);
  console.log("模型重驗會逐一送出短請求，可能耗用少量 token。");
  for (const name of names) {
    const def = cfg.agents[name];
    if (!def) throw new Error(`未定義的 agent：${name}`);
    for (const item of def.models ?? []) {
      const checked = await probeModel(def, item.name, undefined, item.effort);
      const at = new Date().toISOString();
      const mark = checked.status === "ok" ? "✅" : checked.status === "unverifiable" ? "⚪" : "❌";
      const result = checked.status === "ok" ? `可呼叫${checked.resolvedModel ? ` → ${checked.resolvedModel}` : ""}${def.adapter === "command" ? "（由自訂探測命令回報）" : ""}` : checked.reason;
      console.log(`${mark} ${at} ${name} ${item.name}: ${result}`);
    }
  }
});

selection.command("mode [mode]").action((mode?: string) => {
  if (!mode) return console.log(`模型模式：${loadRepoConfig().modelSelection.mode}`);
  if (mode !== "balanced" && mode !== "adaptive") throw new Error(`未知的模型模式：${mode}`);
  writeRawConfig(configPath(), setModelMode(readRawConfig(configPath()), mode));
  console.log(`✅ 模型模式已設為 ${mode}`);
});

selection.command("stage [stage] [strength]").action((stage?: string, strength?: string) => {
  if (!stage || !strength) {
    const all = effectiveStageStrengths(loadRepoConfig());
    const stages = stage ? [parseModelStage(stage)] : (Object.keys(all) as Array<keyof typeof all>);
    for (const s of stages) console.log(`${s}: ${all[s].strength}${all[s].custom ? "（自訂）" : "（預設）"}`);
    return;
  }
  writeRawConfig(configPath(), setStageStrength(readRawConfig(configPath()), parseModelStage(stage), parseStrength(strength)));
  console.log(`✅ ${stage} 的最低強度已設為 ${strength}`);
});

/** 檢查設定的 agent 是否已安裝，印出參與的 agent 與主要設定 */
async function doctor(): Promise<void> {
  const cfg = loadRepoConfig();
  const names = Object.keys(cfg.agents);
  if (!names.length) console.log("還沒有設定任何 agent，請用 config agent setup 互動設定，或用 config agent add <name> --adapter <adapter> 新增");
  for (const name of names) {
    const def = resolveAgent(cfg, name);
    const ok = await probeAgent(def);
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(10)} adapter=${def.adapter}${def.model ? ` model=${def.model}` : ""}`);
  }
  try {
    console.log(`\n參與的 agent：${(await resolveCycle()).join("、")}`);
  } catch (e) {
    console.log(`\n${(e as Error).message}`);
  }
  console.log(`\n單一 run 的 agent 執行上限：計畫定案前 ${cfg.maxAgentRuns} 次；定案後為已執行次數加上任務數 × ${cfg.agentRunsPerTask}`);
  console.log(`修正策略：${cfg.fixStrategy}　測試與實作分開：${cfg.tddSplit ? "是" : "否"}`);
  console.log(`程式碼審查人數：${cfg.reviewQuorum}　計畫審查人數：${cfg.planReviewQuorum}　計畫仲裁：${cfg.planArbiter ? "開啟" : "關閉"}`);
  console.log(`同一輪審查者同時執行上限：${cfg.reviewConcurrency ?? "不限"}`);
  console.log(`同一次驗證的檢查同時執行上限：${cfg.checksConcurrency ?? "不限"}`);
  console.log(`沒有相依關係的任務同時執行上限：${cfg.taskConcurrency ?? "不限"}`);
  const layers = cfg.planReviewLayers;
  console.log(`計畫分層審查：${layers.enabled ? `任務達 ${layers.minTasks} 個時開啟，最多 ${layers.maxGroups} 群，每群平均至少 ${layers.tasksPerGroup} 個任務` : "關閉"}`);
  const diverge = cfg.diverge;
  console.log(`重試前短發散：${diverge.enabled ? `同一關失敗 ${diverge.after} 次後開啟，${diverge.branches} 個分支` : "關閉"}`);
}

configCmd.command("doctor").description("檢查可用的 agent CLI 與目前參與的 agent").action(doctor);

program
  .command("list")
  .description("列出這個專案的所有 run")
  .action(() => {
    for (const r of listRuns()) {
      const req = r.requirement.split("\n")[0]!.slice(0, 40);
      console.log(`${r.id}  ${r.stage.padEnd(17)}  ${String(agentRuns(r.id)).padStart(3)} 次  ${r.updatedAt.slice(0, 16)}  ${req}`);
    }
  });

program
  .command("logs <id> [seq]")
  .description("列出 log；指定編號（或 --latest）時顯示解析後的內容，最後附上錯誤整理")
  .option("--latest", "顯示最新一份 log", false)
  .option("--full", "逐條顯示 shell 指令，完整顯示工具內容（多行指令、絕對路徑）與重複的最後回覆", false)
  .option("--raw", "顯示原始內容（agent 的 JSON 行）", false)
  .action((id: string, seq: string | undefined, opts: { latest: boolean; full: boolean; raw: boolean }) => {
    mustGetRun(id);
    const logs = listLogs(logDir(id));
    if (!logs.length) return console.log("還沒有 log");
    if (!seq && !opts.latest) {
      console.log("  #  結果  階段          步驟                 agent       開始時間");
      for (const e of logs) {
        const h = e.header;
        console.log(
          `${String(e.seq).padStart(3)}  ${logMark(e).padEnd(4)}  ${(h?.stage ?? "?").padEnd(12)}  ${(h?.step ?? "?").padEnd(19)}  ${(h?.agent ?? "?").padEnd(10)}  ${localTime(h?.startedAt)}`,
        );
      }
      console.log(`\n查看內容：agentflowctl logs ${id} <編號>（加 --full 看完整工具內容、--raw 看原始 JSON）`);
      return;
    }
    const entry = seq ? logs.find((e) => e.seq === Number(seq)) : logs.at(-1);
    if (!entry) throw new Error(`找不到 log #${seq}（共 ${logs.length} 份，可用 agentflowctl logs ${id} 列出）`);
    const text = readFileSync(entry.file, "utf8");
    console.log(opts.raw ? text : renderLog(text, entry.file, { full: opts.full }));
  });

program
  .command("stats <id>")
  .description("依步驟統計耗時、執行次數與失敗次數，找出最花時間與最常重試的地方")
  .action((id: string) => {
    mustGetRun(id);
    const stats = computeStats(listLogs(logDir(id)));
    if (!stats.steps.length) return console.log("還沒有 log");
    const total = stats.agentMs + stats.cmdMs;
    const share = (ms: number) => (total ? `${(ms / total * 100).toFixed(0)}%` : "-");
    console.log(`總經過時間 ${formatDuration(stats.wallMs)}（含暫停與等待核准）`);
    console.log(`  agent    ${formatDuration(stats.agentMs).padStart(7)}  ${share(stats.agentMs)}`);
    console.log(`  專案指令 ${formatDuration(stats.cmdMs).padStart(7)}  ${share(stats.cmdMs)}`);
    if (stats.unfinished) console.log(`  未完成 ${stats.unfinished} 份（沒有結束紀錄，不計入耗時）`);
    console.log("\n  步驟                 類型   次數  失敗   總耗時     最長   占比");
    for (const s of stats.steps) {
      console.log(
        `  ${s.step.padEnd(19)}  ${s.kind === "cmd" ? "指令 " : "agent"}  ${String(s.runs).padStart(4)}  ${String(s.failed).padStart(4)}  ${formatDuration(s.totalMs).padStart(7)}  ${formatDuration(s.maxMs).padStart(7)}  ${share(s.totalMs).padStart(5)}${s.unfinished ? `  （未完成 ${s.unfinished}）` : ""}`,
      );
    }
    console.log(`\n次數多或失敗多的步驟可用 agentflowctl logs ${id} 找出編號查看原因；token 用量見 agentflowctl status ${id}`);
  });

program
  .command("insights")
  .description("彙總這個專案所有 run 的結果、失敗原因、用量、步驟失敗與重試原因，並給出改善建議")
  .action(() => {
    const runs = listRuns();
    if (!runs.length) return console.log("還沒有 run");
    const rows = runs.map((r) => ({
      id: r.id,
      stage: r.stage,
      failureCategory: r.failureCategory,
      retries: listRetries(r.id),
      usage: listUsage(r.id),
      substitutions: listSubstitutions(r.id).length,
      stats: computeStats(listLogs(logDir(r.id))),
    }));
    const insights = computeInsights(rows);
    const usage = computeUsageInsights(rows);
    const o = insights.byOutcome;
    console.log(`專案彙總（${insights.runCount} 個 run）`);
    console.log(`  完成 ${o.done}  失敗 ${o.failed}  暫停 ${o.paused}  等待核准 ${o.awaiting_approval}  進行中 ${o.active}`);
    if (insights.byFailure.length) {
      console.log("\n失敗原因");
      for (const row of insights.byFailure) console.log(`  ${padDisplay(failureLabel(row.category), 20)}  ${String(row.count).padStart(4)} 個 run`);
    }

    const t = usage.total;
    console.log("\n用量");
    if (t.runs) {
      const value = t.reportedRuns
        ? `輸入 ${t.inputTokens}${cacheNote(t)}、輸出 ${t.outputTokens}、合計 ${t.tokens} tokens`
        : "未回報或回報狀態不明";
      console.log(`  ${value}；${t.runs} 次（未回報 ${t.unreportedRuns}、舊紀錄不明 ${t.legacyRuns}）`);
    } else console.log("  還沒有用量紀錄");

    const byStrength = usage.byStrength;
    const reportedTotal = Object.values(byStrength).reduce((sum, entry) => sum + entry.tokens, 0);
    if (Object.keys(byStrength).length) {
      console.log("\n模型強度用量（占比只計入明確回報）");
      for (const strength of ["low", "medium", "high", "未知"]) {
        const entry = byStrength[strength];
        if (!entry) continue;
        const share = reportedTotal ? `${(entry.tokens / reportedTotal * 100).toFixed(1)}%` : "無法計算";
        console.log(`  ${strength}: ${entry.tokens} tokens，占比 ${share}，呼叫 ${entry.runs} 次（未回報 ${entry.unreportedRuns}、舊紀錄不明 ${entry.legacyRuns}）`);
      }
      console.log(`  高強度呼叫：${byStrength.high?.runs ?? 0} 次`);
    }

    const byTokens = (record: Record<string, typeof t>, n: number) =>
      Object.entries(record).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, n);
    printUsage("用量最高的階段", byTokens(usage.byStage, 8));
    printUsage("各 agent 用量", byTokens(usage.byAgent, 8));
    printUsage("各模型與步驟用量（任務步驟不分 task id，只加總明確回報）", byTokens(usage.byModelStage, 10));

    const ss = usage.stepStats;
    if (ss.steps.length) {
      const totalMs = ss.agentMs + ss.cmdMs;
      const share = (ms: number) => (totalMs ? `${(ms / totalMs * 100).toFixed(0)}%` : "-");
      console.log("\n步驟執行與失敗（跨 run，任務步驟不分 task id，依失敗次數排序，不含總經過時間）");
      console.log(`  agent    ${formatDuration(ss.agentMs).padStart(7)}  ${share(ss.agentMs)}`);
      console.log(`  專案指令 ${formatDuration(ss.cmdMs).padStart(7)}  ${share(ss.cmdMs)}`);
      if (ss.unfinished) console.log(`  未完成 ${ss.unfinished} 份（沒有結束紀錄，不計入耗時）`);
      console.log("\n  步驟                 類型   次數  失敗   總耗時     最長");
      for (const s of ss.steps.slice(0, 10)) {
        console.log(
          `  ${s.step.padEnd(19)}  ${s.kind === "cmd" ? "指令 " : "agent"}  ${String(s.runs).padStart(4)}  ${String(s.failed).padStart(4)}  ${formatDuration(s.totalMs).padStart(7)}  ${formatDuration(s.maxMs).padStart(7)}${s.unfinished ? `  （未完成 ${s.unfinished}）` : ""}`,
        );
      }
    }

    if (!insights.byCategory.length) console.log("\n還沒有重試紀錄（舊 run 不會回填）");
    else {
      console.log("\n重試原因");
      for (const row of insights.byCategory) {
        const finals = row.finals ? `，其中 ${row.finals} 次達上限` : "";
        console.log(`  ${padDisplay(retryLabel(row.category), 20)}  ${String(row.count).padStart(4)} 次${finals}`);
      }
      console.log("\n最常重試的關卡（任務關卡不分 task id 合併計算）");
      for (const row of insights.byGate.slice(0, 10)) {
        console.log(`  ${padDisplay(row.gate, 19)}  ${String(row.count).padStart(4)} 次`);
      }
    }

    console.log("\n建議");
    if (!usage.findings.length) console.log("  還沒有足夠訊號");
    else usage.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.title}`);
      console.log(`     ${f.detail}`);
    });

    const usageById = new Map(usage.runs.map((r) => [r.id, r]));
    console.log("\n各 run");
    for (const r of insights.runs) {
      const cat = r.topCategory ? `  最多 ${retryLabel(r.topCategory)}` : "";
      const u = usageById.get(r.id);
      const tokens = !u?.calls ? "" : u.reportedCalls ? `  ${String(u.tokens).padStart(9)} tokens` : `  ${" ".repeat(3)}未回報${" ".repeat(7)}`;
      const task = u?.topTask && u.topTask.tasks >= 2 ? `  最耗任務 ${u.topTask.task}（${(u.topTask.share * 100).toFixed(0)}%）` : "";
      console.log(`  ${r.id}  ${r.stage.padEnd(17)}  重試 ${String(r.retries).padStart(3)} 次${tokens}${task}${cat}`);
    }
    console.log("\n建議對應可改的 prompt、config selection stage 或關卡；各分組是同一批呼叫的不同切片，不要跨組相加。單一 run 用 agentflowctl status <id>、stats <id> 與 logs <id>");
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`錯誤：${(err as Error).message}`);
  process.exit(1);
});
