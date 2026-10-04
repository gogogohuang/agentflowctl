import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { git, removeWorktree } from "./git.js";
import { flowDir, projectRoot, tempWorktreesDir, worktreeDir } from "./paths.js";
import { isSafeDepDirName } from "./profile.js";

export { tempWorktreesDir };

/** agent 的工作環境：dir 是 cwd，flow 是它自己的 .flow/ */
export interface Workspace {
  dir: string;
  flow: string;
  /** 固定路徑被占用而改用唯一路徑時，移除時要一併刪掉的唯一父目錄；沒有時只刪 dir */
  uniqueParent?: string;
}

let created = 0;

/**
 * 把 from 底下的依賴目錄各建一個 symlink 到 to。只連「來源是真目錄、目標還不存在」的名稱：
 * 名稱不安全（例如 detected.json 被手改成 .flow）、來源是一般檔案（例如 .env）或目標已存在時一律略過，
 * 一個壞掉的項目不能讓每次審查或每條車道都失敗。
 */
export function symlinkDepDirs(from: string, to: string, depDirs: readonly string[]): void {
  for (const dir of depDirs) {
    if (!isSafeDepDirName(dir)) continue;
    const deps = join(from, dir);
    try {
      if (!statSync(deps).isDirectory()) continue;
    } catch {
      continue; // 來源不存在
    }
    const target = join(to, dir);
    try {
      lstatSync(target);
      continue; // 目標已存在（含壞掉的 symlink）：不覆蓋
    } catch {
      // 不存在才建
    }
    symlinkSync(deps, target, process.platform === "win32" ? "junction" : "dir");
  }
}

const warn = (what: string, err: unknown) =>
  console.warn(`⚠️  ${what}失敗（下次執行或 clean 會再清）：${(err as Error).message}`);

/**
 * 建立臨時 worktree：detached、內容是 run worktree 的 HEAD，並複製目前的 .flow/（.flow/ 不受 git 管理，要另外帶），
 * run worktree 頂層有依賴目錄（profile.depDirs）時再各建一個指向它的 symlink，讓審查者讀得到依賴。
 * 路徑固定為 tmp-review/<name>：agent CLI（Claude Code、Gemini CLI）會依工作目錄記錄專案，路徑每次不同會一直累積紀錄。
 * 固定路徑被占用（目錄已存在，或殘留的 locked 登記讓 git worktree add 失敗）時才改用唯一的父目錄，basename 仍是 name。
 */
export async function createTempWorktree(runId: string, name: string, depDirs: readonly string[]): Promise<Workspace> {
  const stable = join(tempWorktreesDir(runId), name);
  mkdirSync(tempWorktreesDir(runId), { recursive: true });
  let ws: Workspace | undefined;
  if (!existsSync(stable)) {
    try {
      await git(worktreeDir(runId), "worktree", "add", "--detach", stable, "HEAD");
      ws = { dir: stable, flow: join(stable, ".flow") };
    } catch {
      // 固定路徑被占用：清掉這次可能留下的半成品目錄（原本不存在，是這次建的），改用唯一路徑
      try {
        rmSync(stable, { recursive: true, force: true });
      } catch (err) {
        warn("清掉固定路徑的半成品 ", err);
      }
    }
  }
  if (!ws) {
    const parent = join(tempWorktreesDir(runId), `${process.pid}-${Date.now()}-${created++}`);
    const dir = join(parent, name);
    mkdirSync(parent, { recursive: true });
    await git(worktreeDir(runId), "worktree", "add", "--detach", dir, "HEAD");
    ws = { dir, flow: join(dir, ".flow"), uniqueParent: parent };
  }
  try {
    if (existsSync(flowDir(runId))) cpSync(flowDir(runId), ws.flow, { recursive: true });
    else mkdirSync(ws.flow, { recursive: true });
    symlinkDepDirs(worktreeDir(runId), ws.dir, depDirs);
  } catch (err) {
    await removeTempWorktree(runId, ws); // 不會丟例外，不會蓋掉原本的錯誤
    throw err;
  }
  return ws;
}

/**
 * 移除這次建立的臨時 worktree：固定路徑只刪 dir（絕不刪 tmp-review/ 本身，裡面可能還有別的呼叫在用），唯一路徑連父目錄一起刪。
 * git worktree remove 與 rmSync 都不會跟進依賴目錄 symlink 刪到原本的依賴。
 * 永遠不丟例外：這在 withTempWorktree 的 finally 裡執行，丟出去會蓋掉審查本身的結果（已存檔，甚至可能是額度用完）；
 * 清不掉的只印警告，交給下次 advance 或 clean 的清理。
 */
export async function removeTempWorktree(runId: string, ws: Workspace): Promise<void> {
  let removed = true;
  try {
    await removeWorktree(worktreeDir(runId), ws.dir);
  } catch {
    removed = false; // 目錄可能已經不在：刪掉目錄後再讓 git 忘掉這一個登記
  }
  try {
    rmSync(ws.uniqueParent ?? ws.dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    warn("移除平行審查的臨時 worktree ", err);
    return;
  }
  // 只處理自己這一個登記；repo 層級的 prune 可能清掉使用者其他資料夾暫時不在的 worktree
  if (!removed) await git(worktreeDir(runId), "worktree", "remove", "-f", "-f", ws.dir).catch(() => {});
}

export async function withTempWorktree<T>(runId: string, name: string, depDirs: readonly string[], fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = await createTempWorktree(runId, name, depDirs);
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
 * 這個 run 沒有 tmp-review/ 就什麼都不做（不呼叫 git）；prune 是 repo 層級的，只在確實找到這個 run 的登記時才執行。
 * force（`clean` 用）：tmp-review/ 已不在也照樣列出登記並清掉，否則只剩 locked 登記時會永遠留在 .git/worktrees/。
 * 不丟例外：清不乾淨只印警告，下一次 advance 會再試；固定路徑被殘骸占用時建立會改用唯一路徑，不會被擋住。
 */
export async function cleanupTempWorktrees(runId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && !existsSync(tempWorktreesDir(runId))) return;
  try {
    const repo = existsSync(worktreeDir(runId)) ? worktreeDir(runId) : projectRoot();
    const registered = await registeredTempWorktrees(repo, runId);
    for (const path of registered) {
      await git(repo, "worktree", "remove", "-f", "-f", path).catch(() => {}); // 失敗交給下面的 rmSync 與 prune
    }
    rmSync(tempWorktreesDir(runId), { recursive: true, force: true, maxRetries: 3 });
    if (registered.length) await git(repo, "worktree", "prune");
  } catch (err) {
    warn("清理平行審查的臨時 worktree ", err);
  }
}
