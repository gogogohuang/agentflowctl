import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { exec } from "./proc.js";

/**
 * agentflowctl 執行 git 時一律停用 hooks 與 fsmonitor。
 * Agent 現在直接在你的電腦上執行，理論上可以寫入 .git；
 * 這樣至少確保 agentflowctl 自己的 git 操作不會觸發 repo 內的任何程式。
 */
const NO_HOOKS = join(tmpdir(), "agentflowctl-no-hooks"); // 空目錄，各平台通用（Windows 沒有 /dev/null）
mkdirSync(NO_HOOKS, { recursive: true });
const SAFE = ["-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.fsmonitor=false"];
const AUTHOR = ["-c", "user.name=agentflowctl", "-c", "user.email=agentflowctl@localhost"];

export async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await exec("git", [...SAFE, "-C", repo, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失敗：${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** 把路徑加進所有 worktree 共用的 info/exclude（只加一次） */
export async function excludePaths(root: string, patterns: string[]): Promise<void> {
  let common = await git(root, "rev-parse", "--git-common-dir");
  if (!isAbsolute(common)) common = join(root, common);
  const file = join(common, "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const missing = patterns.filter((p) => !current.split("\n").includes(p));
  if (missing.length) appendFileSync(file, `\n${missing.join("\n")}\n`);
}

/** 從基底分支建立新的 worktree 與分支，共用同一份 git 物件，不需要重新 clone */
export async function addWorktree(root: string, dest: string, base: string, branch: string): Promise<void> {
  await excludePaths(root, [".agentflowctl/", ".flow/"]);
  await git(root, "worktree", "add", "-b", branch, dest, base);
}

export async function removeWorktree(root: string, dest: string): Promise<void> {
  await git(root, "worktree", "remove", "--force", dest);
}

export const headCommit = (repo: string) => git(repo, "rev-parse", "HEAD");

/** 有變更才 commit，回傳新的 commit hash；沒有變更回傳 undefined */
export async function commitAll(repo: string, message: string): Promise<string | undefined> {
  await git(repo, "add", "-A");
  if (!(await git(repo, "status", "--porcelain"))) return undefined;
  await git(repo, ...AUTHOR, "commit", "-m", message);
  return headCommit(repo);
}

/** 回到指定 commit 並清掉未追蹤檔案（被 exclude 或 .gitignore 的檔案不受影響） */
export async function resetTo(repo: string, commit: string): Promise<void> {
  await git(repo, "reset", "--hard", commit);
  await git(repo, "clean", "-fd");
}

export const discardChanges = (repo: string) => resetTo(repo, "HEAD");

export async function changedFiles(repo: string, from: string, to: string, filter?: "D"): Promise<string[]> {
  const args = ["diff", "--name-only", ...(filter ? [`--diff-filter=${filter}`] : []), from, to];
  const out = await git(repo, ...args);
  return out ? out.split("\n") : [];
}
