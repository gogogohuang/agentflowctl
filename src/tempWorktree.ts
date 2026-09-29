import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, removeWorktree } from "./git.js";
import { flowDir, runDir, worktreeDir } from "./paths.js";

/** agent 的工作環境：dir 是 cwd，flow 是它自己的 .flow/ */
export interface Workspace {
  dir: string;
  flow: string;
}

/** 平行審查用的臨時 worktree 都放這裡；孤兒在 advance() 開頭統一清掉 */
export const tempWorktreesDir = (runId: string) => join(runDir(runId), "tmp-review");

/** 建立臨時 worktree：detached、內容是 run worktree 的 HEAD，並複製目前的 .flow/（.flow/ 不受 git 管理，要另外帶） */
export async function createTempWorktree(runId: string, name: string): Promise<Workspace> {
  const dir = join(tempWorktreesDir(runId), name);
  mkdirSync(tempWorktreesDir(runId), { recursive: true });
  await git(worktreeDir(runId), "worktree", "add", "--detach", dir, "HEAD");
  const flow = join(dir, ".flow");
  if (existsSync(flowDir(runId))) cpSync(flowDir(runId), flow, { recursive: true });
  else mkdirSync(flow, { recursive: true });
  return { dir, flow };
}

export async function removeTempWorktree(runId: string, ws: Workspace): Promise<void> {
  try {
    await removeWorktree(worktreeDir(runId), ws.dir);
  } catch {
    // 目錄可能已經不在，登記交給下面的 rmSync 與 cleanupTempWorktrees 的 prune
  }
  rmSync(ws.dir, { recursive: true, force: true });
}

export async function withTempWorktree<T>(runId: string, name: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = await createTempWorktree(runId, name);
  try {
    return await fn(ws);
  } finally {
    await removeTempWorktree(runId, ws);
  }
}

/** 刪掉整個臨時目錄並讓 git 忘掉它們；Ctrl-C（process.exit 不跑 finally）、SIGTERM、當機後都靠這個收拾 */
export async function cleanupTempWorktrees(runId: string): Promise<void> {
  rmSync(tempWorktreesDir(runId), { recursive: true, force: true });
  if (existsSync(worktreeDir(runId))) await git(worktreeDir(runId), "worktree", "prune");
}
