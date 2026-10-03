import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachWorktree, branchCheckedOutAt, git } from "./git.js";
import { flowDir, projectRoot, runDir, worktreeDir } from "./paths.js";
import { FlowRun } from "./schemas.js";
import { getRun, saveRun } from "./store.js";

/** run 目錄下要收的檔案；parallel-review 與 tmp-review 是可重建的中間產物，不收 */
const RUN_ENTRIES = [
  "state.json", "costs.jsonl", "retries.jsonl", "substitutions.jsonl", "handoff.json",
  "plan-review-state.json", "plan-arbitration.json", "diverge.json", "confirmations.json", "confirmation-details.json", "confirmations-restored", "logs", "reviews",
];

const version = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "未知";
  } catch {
    return "未知";
  }
};

async function gitInfo(root: string, base: string, branch: string): Promise<Record<string, string>> {
  const attempt = async (...args: string[]) => {
    try { return await git(root, ...args); } catch (e) { return `（失敗：${(e as Error).message}）`; }
  };
  return {
    status: await attempt("status", "--short"),
    log: await attempt("log", "--oneline", "-20", branch),
    diffStat: await attempt("diff", "--stat", `${base}...${branch}`),
  };
}

/** 把單一 run 的除錯資料複製到 outDir，方便整包交給別人或 agent 看；不修改 run 本身 */
export async function dumpRun(id: string, outDir: string): Promise<void> {
  const run = getRun(id);
  if (!run) throw new Error(`找不到 run：${id}`);
  mkdirSync(outDir, { recursive: true });
  const missing: string[] = [];
  const copy = (from: string, to: string, label: string) => {
    if (existsSync(from)) cpSync(from, join(outDir, to), { recursive: true });
    else missing.push(label);
  };

  for (const name of RUN_ENTRIES) copy(join(runDir(id), name), join("run", name), `run/${name}`);
  copy(flowDir(id), "flow", "flow");
  copy(join(projectRoot(), "flow.config.json"), "flow.config.json", "flow.config.json");

  const meta = {
    runId: id,
    dumpedAt: new Date().toISOString(),
    agentflowctl: version(),
    node: process.version,
    platform: process.platform,
    worktreeExists: existsSync(worktreeDir(id)),
    git: await gitInfo(projectRoot(), run.baseBranch, run.branch),
    missing,
  };
  writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * 把 dumpRun 的輸出還原成可以 resume 的 run：寫回 run 紀錄與 .flow/，並用既有的 flow/<id> 分支重建 worktree。
 * 沿用原 id；run 已存在、分支不在時拒絕，且不留下半成品。dump 裡的 flow.config.json 只供對照，不覆蓋目前的設定。
 */
export async function restoreRun(dumpDir: string): Promise<FlowRun> {
  const stateFile = join(dumpDir, "run", "state.json");
  if (!existsSync(join(dumpDir, "meta.json")) || !existsSync(stateFile)) {
    throw new Error(`${dumpDir} 不是 dump 目錄（缺少 meta.json 或 run/state.json）`);
  }
  const parsed = FlowRun.safeParse(JSON.parse(readFileSync(stateFile, "utf8")));
  if (!parsed.success) throw new Error(`dump 裡的 run/state.json 讀不懂：${parsed.error.message}`);
  const run = parsed.data;
  const id = run.id;
  if (!/^[\w-]+$/.test(id)) throw new Error(`不合法的 run id：${id}`);
  if (getRun(id) || existsSync(runDir(id)) || existsSync(worktreeDir(id))) {
    throw new Error(`run ${id} 已存在，請先 agentflowctl clean ${id} 再復原`);
  }
  const root = projectRoot();
  try {
    await git(root, "rev-parse", "--verify", `refs/heads/${run.branch}`);
  } catch {
    throw new Error(`找不到分支 ${run.branch}，無法重建 worktree；請先把分支補回這個 repo`);
  }
  const usedAt = await branchCheckedOutAt(root, run.branch);
  if (usedAt) {
    throw new Error(`分支 ${run.branch} 已在 ${usedAt} 簽出，無法再建 worktree；請先在那裡切到別的分支（例如 git switch ${run.baseBranch}）再復原`);
  }
  try {
    await attachWorktree(root, worktreeDir(id), run.branch);
    mkdirSync(runDir(id), { recursive: true });
    for (const name of readdirSync(join(dumpDir, "run"))) {
      if (name !== "state.json") cpSync(join(dumpDir, "run", name), join(runDir(id), name), { recursive: true });
    }
    if (existsSync(join(dumpDir, "flow"))) cpSync(join(dumpDir, "flow"), flowDir(id), { recursive: true });
    // state.json 最後寫：它出現才算復原完成，中途失敗不會留下 getRun 看得到的半成品
    return saveRun(run);
  } catch (err) {
    rmSync(runDir(id), { recursive: true, force: true });
    await git(root, "worktree", "remove", "--force", worktreeDir(id)).catch(() => rmSync(worktreeDir(id), { recursive: true, force: true }));
    await git(root, "worktree", "prune").catch(() => {});
    throw err;
  }
}
