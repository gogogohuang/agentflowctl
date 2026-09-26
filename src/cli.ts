#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { advance, loadRepoConfig } from "./engine.js";
import { probeAgent, resolveAgent, runCommand } from "./runner.js";
import { addWorktree, git, removeWorktree } from "./git.js";
import { flowDir, logDir, projectRoot, runDir, worktreeDir } from "./paths.js";
import { TaskList, type FlowRun } from "./schemas.js";
import { agentRuns, getRun, listRuns, listSubstitutions, saveRun, usageByAgent } from "./store.js";
import { readJsonFile } from "./util.js";
import { addAgent, readRawConfig, removeAgent, setAgent, setCycle, writeRawConfig, type Edit } from "./agentConfig.js";

function mustGetRun(id: string): FlowRun {
  const run = getRun(id);
  if (!run) throw new Error(`找不到 run：${id}`);
  return run;
}

async function drive(run: FlowRun): Promise<void> {
  // Ctrl-C 會同時送給子程序（claude、測試指令），狀態已經寫在 state.json，之後可用 resume 接續
  process.once("SIGINT", () => {
    console.log(`\n已中斷，之後可用 agentflowctl resume ${run.id} 接續`);
    process.exit(130);
  });
  printSummary(await advance(run));
}

function printSummary(run: FlowRun): void {
  console.log("");
  console.log(`run      ${run.id}`);
  console.log(`階段     ${run.stage}`);
  console.log(`用量     agent 執行 ${agentRuns(run.id)} / ${run.maxAgentRuns} 次`);
  console.log(`agent    ${run.cycle.join(" → ")}${run.lastWriter ? `（最後作者：${run.lastWriter}）` : ""}`);
  console.log(`分支     ${run.branch}`);
  console.log(`worktree ${worktreeDir(run.id)}`);
  if (run.prUrl) console.log(`PR       ${run.prUrl}`);
  if (run.planWriter) console.log(`計畫     作者 ${run.planWriter}${run.planReviewer ? `，最後提出意見的是 ${run.planReviewer}` : ""}`);
  if (run.stage === "failed") {
    console.log(`失敗於   ${run.failedStage ?? "?"}`);
    console.log(`原因     ${run.failureReason ?? "?"}`);
    console.log(`\n可檢查 ${logDir(run.id)}，必要時直接在 worktree 裡修正，再執行 agentflowctl resume ${run.id}`);
  }
  if (run.stage === "paused") {
    console.log(`暫停於   ${run.pausedStage ?? "?"}`);
    console.log(`原因     ${run.pauseReason ?? "?"}`);
    console.log(`\n額度恢復後執行 agentflowctl resume ${run.id}`);
  }
  if (run.stage === "awaiting_approval") console.log(`\n確認計畫後執行 agentflowctl approve ${run.id}`);
}

/** 決定輪替順序：指令參數 > flow.config.json > 自動偵測已安裝的 CLI */
async function resolveCycle(flag?: string): Promise<string[]> {
  const cfg = loadRepoConfig();
  const wanted = flag ? flag.split(",").map((s) => s.trim()).filter(Boolean) : cfg.cycle;
  if (wanted) {
    for (const name of wanted) {
      if (!(await probeAgent(resolveAgent(cfg, name)))) throw new Error(`找不到可執行的 agent：${name}（可用 agentflowctl doctor 檢查）`);
    }
    return wanted;
  }
  // 沒有內建 agent：只從 agents 裡定義的挑出已安裝的
  const defined = Object.keys(cfg.agents);
  if (!defined.length) throw new Error("還沒有設定任何 agent，請先用 agentflowctl agent add <name> --adapter <adapter> 新增");
  const found: string[] = [];
  for (const name of defined) if (await probeAgent(resolveAgent(cfg, name))) found.push(name);
  if (!found.length) throw new Error(`設定的 agent（${defined.join("、")}）都沒有偵測到已安裝的 CLI，可用 agentflowctl doctor 檢查`);
  return found;
}

const program = new Command()
  .name("agentflowctl")
  .description("在專案資料夾內執行的 Agent 開發流程：規格 → 計畫 → TDD 實作 → 驗證 → 審查 → PR");

program
  .command("run")
  .description("在目前的專案建立並執行新的 flow")
  .option("--req <text>", "需求描述")
  .option("--req-file <file>", "從檔案讀取需求")
  .option("--base <branch>", "基底分支（預設為目前的分支）")
  .option("--max-agent-runs <n>", "單一 run 最多執行幾次 agent（預設取 flow.config.json 的 maxAgentRuns）")
  .option("--manual-plan", "計畫通過 AI 審查後，仍停下來等你確認", false)
  .option("--cycle <agents>", "agent 輪替順序，例如 claude,codex,gemini")
  .action(async (opts: { req?: string; reqFile?: string; base?: string; maxAgentRuns?: string; manualPlan: boolean; cycle?: string }) => {
    const requirement = opts.reqFile ? readFileSync(opts.reqFile, "utf8") : opts.req;
    if (!requirement?.trim()) throw new Error("請用 --req 或 --req-file 提供需求");
    const root = projectRoot();
    const base = opts.base ?? (await git(root, "branch", "--show-current"));
    if (!base) throw new Error("目前不在任何分支上，請用 --base 指定基底分支");
    const cycle = await resolveCycle(opts.cycle);
    const id = `f-${Date.now().toString(36)}`;
    const branch = `flow/${id}`;
    console.log(`[${id}] 🌿 從 ${base} 建立 worktree（分支 ${branch}）`);
    await addWorktree(root, worktreeDir(id), base, branch);
    console.log(`[${id}] 🤝 agent 輪替順序：${cycle.join(" → ")}`);
    // 先裝好相依套件：有些 agent 的沙箱不能連網，無法自己安裝
    const cfg = loadRepoConfig();
    const install = await runCommand({ runId: id, cwd: worktreeDir(id), logFile: join(logDir(id), "install.log") }, cfg.install);
    if (!install.ok) console.log(`[${id}] ⚠️  安裝相依套件失敗，稍後 verify 階段會再試一次（見 ${join(logDir(id), "install.log")}）`);
    const now = new Date().toISOString();
    const run = saveRun({
      id,
      baseBranch: base,
      branch,
      requirement: requirement.trim(),
      stage: "spec",
      autopilot: !opts.manualPlan,
      maxAgentRuns: opts.maxAgentRuns ? Number(opts.maxAgentRuns) : cfg.maxAgentRuns,
      cycle,
      attempts: {},
      taskIndex: 0,
      taskPhase: "tests",
      createdAt: now,
      updatedAt: now,
    });
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
  .command("resume <id>")
  .description("從暫停、中斷或失敗的階段接續")
  .option("--max-agent-runs <n>", "調整 agent 執行次數上限")
  .action(async (id: string, opts: { maxAgentRuns?: string }) => {
    let run = mustGetRun(id);
    if (opts.maxAgentRuns) run = { ...run, maxAgentRuns: Number(opts.maxAgentRuns) };
    if (run.stage === "paused") {
      run = { ...run, stage: run.pausedStage ?? "spec", pausedStage: undefined, pauseReason: undefined };
    }
    if (run.stage === "failed") {
      run = { ...run, stage: run.failedStage ?? "spec", attempts: {}, failedStage: undefined, failureReason: undefined };
    }
    await drive(saveRun(run));
  });

program
  .command("cancel <id>")
  .description("標記 run 為失敗（執行中的 run 請直接在該終端機按 Ctrl-C）")
  .action((id: string) => {
    const run = mustGetRun(id);
    saveRun({ ...run, stage: "failed", failedStage: run.stage, failureReason: "使用者取消" });
    console.log(`已取消 ${id}`);
  });

program
  .command("clean <id>")
  .description("移除 run 的 worktree 與紀錄（分支會保留）")
  .action(async (id: string) => {
    mustGetRun(id);
    if (existsSync(worktreeDir(id))) await removeWorktree(projectRoot(), worktreeDir(id));
    rmSync(runDir(id), { recursive: true, force: true });
    console.log(`已清除 ${id}，分支仍保留，不需要時可用 git branch -D 刪除`);
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
        console.log(`  ${agent.padEnd(10)} ${String(c.runs).padStart(3)} 次  ${String(c.tokens).padStart(9)} tokens`);
      }
    }
    const subs = listSubstitutions(id);
    if (subs.length) {
      console.log("\n代打紀錄");
      for (const sub of subs) console.log(`  ${sub.at.slice(0, 16)}  ${sub.step.padEnd(14)} ${sub.planned} → ${sub.actual}${sub.note ? `（${sub.note}）` : ""}`);
    }
    const tasks = readJsonFile(join(flowDir(id), "tasks.ordered.json"), TaskList);
    if (!tasks.ok) return;
    console.log("\n任務");
    tasks.data.forEach((t, i) => {
      const active = i === run.taskIndex && run.stage === "implement";
      const mark = i < run.taskIndex ? "✅" : active ? (run.taskPhase === "tests" ? "🧪" : "🛠️ ") : "⬜";
      console.log(`  ${mark} ${t.id} ${t.title}`);
    });
  });

// ───────────── agent 管理：讀寫 flow.config.json 的 agents 與 cycle ─────────────

const configPath = () => join(projectRoot(), "flow.config.json");
const collect = (value: string, prev: string[] = []) => [...prev, value];

function applyEdit(edit: (cfg: Record<string, unknown>) => Edit, done: string): void {
  const before = readRawConfig(configPath());
  const { cfg, changes } = edit(before);
  writeRawConfig(configPath(), cfg);
  console.log(`✅ ${done}（${configPath()}）`);
  for (const c of changes) console.log(`   ↳ ${c}`);
  if (JSON.stringify(before.cycle) !== JSON.stringify(cfg.cycle)) {
    console.log("   已建立的 run 會沿用建立時的輪替順序，不受影響");
  }
}

const agent = program.command("agent").description("管理 agent 與 adapter 設定（寫入 flow.config.json）");

agent
  .command("list")
  .description("列出設定的 agent、是否已安裝、在輪替中的位置")
  .action(async () => {
    const cfg = loadRepoConfig();
    const cycle = await resolveCycle().catch(() => cfg.cycle ?? []);
    const names = Object.keys(cfg.agents);
    if (!names.length) console.log("還沒有設定任何 agent，請用 agent add <name> --adapter <adapter> 新增");
    for (const name of names) {
      const def = resolveAgent(cfg, name);
      const ok = await probeAgent(def);
      const pos = cycle.indexOf(name);
      const detail = [
        `adapter=${def.adapter}`,
        def.model && `model=${def.model}`,
        def.extraArgs.length && `extraArgs=${def.extraArgs.join(" ")}`,
        def.command && `command=${def.command.join(" ")}`,
      ].filter(Boolean);
      console.log(`${ok ? "✅" : "❌"} ${name.padEnd(14)} ${pos >= 0 ? `輪替 #${pos + 1}` : "不在輪替"}  ${detail.join(" ")}`);
    }
    console.log(`
輪替順序：${cycle.length ? cycle.join(" → ") : "（沒有可用的 agent）"}${cfg.cycle ? "" : "（自動偵測）"}`);
  });

agent
  .command("add <name> [command...]")
  .description("新增 agent；command adapter 的指令寫在 -- 後面")
  .requiredOption("--adapter <adapter>", "claude、codex、gemini 或 command")
  .option("--model <model>", "模型名稱")
  .option("--extra-arg <arg>", "額外參數，可重複；以 - 開頭時寫成 --extra-arg=--sandbox", collect)
  .action((name: string, command: string[], opts: { adapter: string; model?: string; extraArg?: string[] }) => {
    applyEdit(
      (cfg) => addAgent(cfg, name, { adapter: opts.adapter, model: opts.model, extraArgs: opts.extraArg, command: command.length ? command : undefined }),
      `已新增 ${name}；要加進輪替請用 agent cycle`,
    );
  });

agent
  .command("set <name> [command...]")
  .description("修改 agent；更換 adapter 時會清掉舊 adapter 的 model、extraArgs、command")
  .option("--adapter <adapter>", "claude、codex、gemini 或 command")
  .option("--model <model>", "模型名稱")
  .option("--extra-arg <arg>", "額外參數，可重複，會整個取代原本的設定", collect)
  .action((name: string, command: string[], opts: { adapter?: string; model?: string; extraArg?: string[] }) => {
    applyEdit(
      (cfg) => setAgent(cfg, name, { adapter: opts.adapter, model: opts.model, extraArgs: opts.extraArg, command: command.length ? command : undefined }),
      `已更新 ${name}`,
    );
  });

agent
  .command("remove <name>")
  .description("刪除 agent，一併從輪替移除")
  .action((name: string) => applyEdit((cfg) => removeAgent(cfg, name), `已移除 ${name}`));

agent
  .command("cycle [names]")
  .description("顯示輪替順序，或用逗號分隔設定新的順序")
  .action(async (names?: string) => {
    if (!names) {
      const cfg = loadRepoConfig();
      console.log(`${(await resolveCycle()).join(" → ")}${cfg.cycle ? "" : "（自動偵測）"}`);
      return;
    }
    const list = names.split(",").map((s) => s.trim()).filter(Boolean);
    applyEdit((cfg) => setCycle(cfg, list), `輪替順序設為 ${list.join(" → ")}`);
    const cfg = loadRepoConfig();
    for (const n of list) {
      if (!(await probeAgent(resolveAgent(cfg, n)))) console.log(`⚠️  ${n} 目前找不到可執行的 CLI，run 會失敗，請先安裝或用 agent set 修正`);
    }
  });

program
  .command("doctor")
  .description("檢查可用的 agent CLI 與目前的輪替設定")
  .action(async () => {
    const cfg = loadRepoConfig();
    const names = Object.keys(cfg.agents);
    if (!names.length) console.log("還沒有設定任何 agent，請用 agent add <name> --adapter <adapter> 新增");
    for (const name of names) {
      const def = resolveAgent(cfg, name);
      const ok = await probeAgent(def);
      console.log(`${ok ? "✅" : "❌"} ${name.padEnd(10)} adapter=${def.adapter}${def.model ? ` model=${def.model}` : ""}`);
    }
    try {
      console.log(`\n輪替順序：${(await resolveCycle()).join(" → ")}`);
    } catch (e) {
      console.log(`\n${(e as Error).message}`);
    }
    console.log(`\n單一 run 的 agent 執行上限：${cfg.maxAgentRuns} 次`);
    console.log(`修正策略：${cfg.fixStrategy}　測試與實作分開：${cfg.tddSplit ? "是" : "否"}`);
    console.log(`程式碼審查人數：${cfg.reviewQuorum}　計畫審查人數：${cfg.planReviewQuorum}　計畫仲裁：${cfg.planArbiter ? "開啟" : "關閉"}`);
  });

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
  .command("logs <id>")
  .description("列出 log 檔，或顯示最新一份")
  .option("--latest", "顯示最新一份 log 的內容", false)
  .action((id: string, opts: { latest: boolean }) => {
    mustGetRun(id);
    const dir = logDir(id);
    const files = existsSync(dir) ? readdirSync(dir).sort() : [];
    if (!files.length) return console.log("還沒有 log");
    if (!opts.latest) return files.forEach((f) => console.log(join(dir, f)));
    console.log(readFileSync(join(dir, files.at(-1)!), "utf8"));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`錯誤：${(err as Error).message}`);
  process.exit(1);
});
