import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { flowDir, projectRoot, runDir, worktreeDir } from "./paths.js";
import { getRun } from "./store.js";

/** run 目錄下要收的檔案；parallel-review 與 tmp-review 是可重建的中間產物，不收 */
const RUN_ENTRIES = [
  "state.json", "costs.jsonl", "retries.jsonl", "substitutions.jsonl", "handoff.json",
  "plan-review-state.json", "plan-arbitration.json", "confirmations.json", "confirmation-details.json", "logs", "reviews",
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
