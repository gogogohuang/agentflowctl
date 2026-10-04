import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

/**
 * 依賴目錄（例如 pip 在 worktree 內建的 .venv）寫進共用的 info/exclude，以 / 開頭只比對每個 worktree 的頂層：
 * 沒排除時 commitAll 的 add -A 會把整個依賴目錄 commit 進分支，resetTo 的 clean -fd 則會刪掉它
 * （clean 沒加 -x 會尊重 exclude）。不寫結尾的 /，車道裡同名的 symlink 也排除得到。
 */
export async function excludeDepDirs(root: string, depDirs: readonly string[]): Promise<void> {
  if (depDirs.length) await excludePaths(root, depDirs.map((d) => `/${d}`));
}

/** 從基底分支建立新的 worktree 與分支，共用同一份 git 物件，不需要重新 clone */
export async function addWorktree(root: string, dest: string, base: string, branch: string): Promise<void> {
  await excludePaths(root, [".agentflowctl/", ".flow/"]);
  await git(root, "worktree", "add", "-b", branch, dest, base);
}

/** 用已存在的分支建立 worktree（復原 dump 用） */
export async function attachWorktree(root: string, dest: string, branch: string): Promise<void> {
  await excludePaths(root, [".agentflowctl/", ".flow/"]);
  await git(root, "worktree", "prune");
  await git(root, "worktree", "add", dest, branch);
}

/** 分支目前被哪個 worktree 簽出（含主專案）；沒被簽出時回傳 undefined */
export async function branchCheckedOutAt(root: string, branch: string): Promise<string | undefined> {
  const out = await git(root, "worktree", "list", "--porcelain");
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  }
  return undefined;
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

/** 把分支併進目前所在的分支（保留合併 commit）；衝突時還原並回傳衝突的檔案，不留下半套合併 */
export async function mergeBranch(repo: string, branch: string, message: string): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[] }> {
  const r = await exec("git", [...SAFE, ...AUTHOR, "-C", repo, "merge", "--no-ff", "-m", message, branch]);
  if (r.code === 0) return { ok: true, commit: await headCommit(repo) };
  const conflicts = (await git(repo, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
  await exec("git", [...SAFE, "-C", repo, "merge", "--abort"]);
  if (!conflicts.length) throw new Error(`git merge ${branch} 失敗：${(r.stderr || r.stdout).trim()}`);
  return { ok: false, conflicts };
}

/** 分支是否已經在目前的歷史裡（已合併過） */
export async function isMerged(repo: string, branch: string): Promise<boolean> {
  const r = await exec("git", [...SAFE, "-C", repo, "merge-base", "--is-ancestor", branch, "HEAD"]);
  return r.code === 0;
}

export const discardChanges = (repo: string) => resetTo(repo, "HEAD");

export async function changedFiles(repo: string, from: string, to: string, filter?: "D"): Promise<string[]> {
  const args = ["diff", "--name-only", ...(filter ? [`--diff-filter=${filter}`] : []), from, to];
  const out = await git(repo, ...args);
  return out ? out.split("\n") : [];
}

/** 工作樹目前有變動的路徑（已修改、新增、刪除與未追蹤；被 exclude 或 .gitignore 的不算） */
export async function dirtyPaths(repo: string): Promise<string[]> {
  const r = await exec("git", [...SAFE, "-C", repo, "status", "--porcelain", "-uall"]); // git() 會 trim，吃掉第一行開頭的狀態空白
  if (r.code !== 0) throw new Error(`git status 失敗：${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, ""));
}

/** 把路徑還原成指定 commit 的樣子：該 commit 有就取回，沒有就刪掉 */
export async function restorePaths(repo: string, ref: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const exists = await exec("git", [...SAFE, "-C", repo, "cat-file", "-e", `${ref}:${path}`]);
    if (exists.code === 0) await git(repo, "checkout", ref, "--", path);
    else rmSync(join(repo, path), { force: true, recursive: true });
  }
}
