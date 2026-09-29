import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { git, removeWorktree } from "./git.js";
import { flowDir, projectRoot, tempWorktreesDir, worktreeDir } from "./paths.js";

export { tempWorktreesDir };

/** agent 的工作環境：dir 是 cwd，flow 是它自己的 .flow/ */
export interface Workspace {
  dir: string;
  flow: string;
}

let created = 0;

/**
 * 建立臨時 worktree：detached、內容是 run worktree 的 HEAD，並複製目前的 .flow/（.flow/ 不受 git 管理，要另外帶），
 * run worktree 頂層有 node_modules 時再建一個指向它的 symlink，讓審查者讀得到依賴。
 * 每次都放在唯一的父目錄下（basename 仍是 name）：被中斷的前一個程序留下的 agent 可能還在寫舊路徑，也不會撞到舊的 git 登記。
 */
export async function createTempWorktree(runId: string, name: string): Promise<Workspace> {
  const dir = join(tempWorktreesDir(runId), `${process.pid}-${Date.now()}-${created++}`, name);
  mkdirSync(dirname(dir), { recursive: true });
  await git(worktreeDir(runId), "worktree", "add", "--detach", dir, "HEAD");
  const ws = { dir, flow: join(dir, ".flow") };
  try {
    if (existsSync(flowDir(runId))) cpSync(flowDir(runId), ws.flow, { recursive: true });
    else mkdirSync(ws.flow, { recursive: true });
    const deps = join(worktreeDir(runId), "node_modules");
    if (existsSync(deps)) symlinkSync(deps, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    await removeTempWorktree(runId, ws);
    throw err;
  }
  return ws;
}

/** 移除臨時 worktree 與它唯一的父目錄；git worktree remove 與 rmSync 都不會跟進 node_modules symlink 刪到原本的依賴 */
export async function removeTempWorktree(runId: string, ws: Workspace): Promise<void> {
  let removed = true;
  try {
    await removeWorktree(worktreeDir(runId), ws.dir);
  } catch {
    removed = false; // 目錄可能已經不在：刪掉目錄後再 prune，不留下過期的登記
  }
  rmSync(dirname(ws.dir), { recursive: true, force: true, maxRetries: 3 });
  if (!removed) await git(worktreeDir(runId), "worktree", "prune").catch(() => {});
}

export async function withTempWorktree<T>(runId: string, name: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = await createTempWorktree(runId, name);
  try {
    return await fn(ws);
  } finally {
    await removeTempWorktree(runId, ws);
  }
}

/** git worktree list 裡登記在這個 run 臨時目錄下的 worktree（含 locked 的） */
async function registeredTempWorktrees(repo: string, runId: string): Promise<string[]> {
  const base = tempWorktreesDir(runId);
  const prefixes = [base + sep];
  try {
    prefixes.push(realpathSync(base) + sep);
  } catch {
    // 目錄已不在：只比對原路徑
  }
  return (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));
}

/**
 * 清掉上次中斷（Ctrl-C 的 process.exit 不跑 finally、SIGTERM、kill -9、當機）留下的臨時 worktree 與 git 登記。
 * git 在 worktree add 途中被強制中止會留下 locked 登記，prune 會略過它，所以先逐個 remove -f -f。
 * 不丟例外：清不乾淨只印警告，下一次 advance 會再試；新的臨時 worktree 用唯一路徑，不會被殘骸擋住。
 */
export async function cleanupTempWorktrees(runId: string): Promise<void> {
  try {
    const repo = existsSync(worktreeDir(runId)) ? worktreeDir(runId) : existsSync(tempWorktreesDir(runId)) ? projectRoot() : undefined;
    if (repo) {
      for (const path of await registeredTempWorktrees(repo, runId)) {
        await git(repo, "worktree", "remove", "-f", "-f", path).catch(() => {}); // 失敗交給下面的 rmSync 與 prune
      }
    }
    rmSync(tempWorktreesDir(runId), { recursive: true, force: true, maxRetries: 3 });
    if (repo) await git(repo, "worktree", "prune");
  } catch (err) {
    console.warn(`⚠️  清理平行審查的臨時 worktree 失敗（下次執行會再試）：${(err as Error).message}`);
  }
}
