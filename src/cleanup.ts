import { existsSync, readdirSync, rmSync } from "node:fs";
import { git, removeWorktree } from "./git.js";
import { projectRoot, runDir, runsDir, worktreeDir, worktreesDir } from "./paths.js";
import type { Stage } from "./schemas.js";
import { getRun } from "./store.js";

/**
 * 移除一個 run 的 worktree 與紀錄，分支保留。
 * 不需要 state.json：中斷在建立 worktree 之後、寫入紀錄之前留下的孤兒也能清。
 * 回傳是否真的找到並移除了東西。
 */
export async function cleanRun(id: string): Promise<boolean> {
  // id 會拼進要遞迴刪除的路徑，擋掉空字串、..、斜線
  if (!/^[\w-]+$/.test(id)) throw new Error(`不合法的 run id：${id}`);
  const root = projectRoot();
  const wt = worktreeDir(id);
  const found = existsSync(wt) || existsSync(runDir(id));
  if (existsSync(wt)) {
    // git 不認得這個資料夾時（登記已被 prune、或 worktree add 做到一半）改成直接刪
    await removeWorktree(root, wt).catch(() => rmSync(wt, { recursive: true, force: true }));
  }
  rmSync(runDir(id), { recursive: true, force: true });
  // 清掉資料夾已不存在的 worktree 登記，否則同名分支之後無法再 checkout
  const before = await git(root, "worktree", "list", "--porcelain");
  await git(root, "worktree", "prune");
  const pruned = before !== (await git(root, "worktree", "list", "--porcelain"));
  return found || pruned;
}

/** 已結束、可以安全清掉的階段；其他階段可能還在跑，或要 resume／approve */
const FINISHED: readonly Stage[] = ["done", "failed"];

/**
 * `clean --all` 要清的 run：已結束的，加上沒有 state.json 的孤兒（stage 為 undefined）。
 * 讀不懂的 state.json 不算孤兒，保留給使用者自己判斷。
 */
export function cleanableRuns(): { id: string; stage?: Stage }[] {
  const ids = new Set<string>();
  for (const dir of [runsDir(), worktreesDir()]) if (existsSync(dir)) for (const id of readdirSync(dir)) ids.add(id);
  const out: { id: string; stage?: Stage }[] = [];
  for (const id of [...ids].sort()) {
    let stage: Stage | undefined;
    try {
      stage = getRun(id)?.stage;
    } catch {
      continue;
    }
    if (stage === undefined || FINISHED.includes(stage)) out.push({ id, stage });
  }
  return out;
}
