import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tail } from "./util.js";
import { isSafeDepDirName, isSafeDirName, type ProfileExtras } from "./profile.js";
import type { DetectedFile, DetectionProposal } from "./schemas.js";

export interface ValidateDeps {
  /** 在臨時 worktree 內跑指令；逾時要回傳 ok: false */
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  /** 臨時 worktree 內追蹤檔的相對路徑 */
  files: string[];
  /** 指令的第一個可執行檔是否存在 */
  hasExecutable(bin: string): boolean;
  /** depDirs：必須是已存在的目錄；skipDirs：目錄存在，或已被 .gitignore 忽略 */
  dirOk(dir: string, field: "depDirs" | "skipDirs"): boolean;
}

export { isSafeDirName };

/**
 * 真實的 dirOk。依賴目錄會被 symlink 進每位審查者與每條車道，所以只收「已存在的真目錄」：
 * git check-ignore 對被忽略的一般檔案（例如 .env）與根本不存在的名稱也回傳成功，不能拿來證明它是目錄。
 * skipDirs 只影響 findFiles 略過哪些名稱，才退而接受「不存在但被 .gitignore 忽略」。
 */
export function proposalDirOk(cwd: string, d: string, field: "depDirs" | "skipDirs"): boolean {
  if (!(field === "depDirs" ? isSafeDepDirName(d) : isSafeDirName(d))) return false;
  try {
    if (statSync(join(cwd, d)).isDirectory()) return true;
    return false; // 存在但不是目錄（一般檔案）：兩種欄位都不收
  } catch {
    // 不存在：依賴目錄一律不收；skipDirs 再看是否被忽略
  }
  if (field === "depDirs") return false;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", d], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export type Validated = Pick<DetectedFile, "install" | "test" | "checks" | "testPattern" | "dropped"> & { profileExtras: ProfileExtras };

/** 空指令與永遠會成功的指令：拿來當檢查等於沒有檢查 */
export function isTrivialCommand(cmd: string): boolean {
  return /^\s*(?:|true|:|exit\s+0|echo\b.*)\s*$/.test(cmd);
}

/** 指令第一個可執行檔，略過 VAR=值 的環境變數前綴 */
export function firstExecutable(cmd: string): string | undefined {
  return cmd.trim().split(/\s+/).find((token) => token !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
}

type Verdict = { ok: true } | { ok: false; reason: string };

async function tryCommand(cmd: string, deps: ValidateDeps): Promise<Verdict> {
  if (isTrivialCommand(cmd)) return { ok: false, reason: `指令沒有實際檢查：${cmd.trim() || "（空）"}` };
  const bin = firstExecutable(cmd);
  if (!bin || !deps.hasExecutable(bin)) return { ok: false, reason: `找不到可執行檔：${bin ?? cmd}` };
  const result = await deps.run(cmd);
  if (result.ok) return { ok: true };
  const output = tail(result.output, 400).trim();
  return { ok: false, reason: `在基底上沒有通過：${cmd}${output ? `\n${output}` : ""}` };
}

/**
 * 逐欄位驗證 agent 的提案；原則是「基底 commit 上必須是綠的」，否則 verify 會永遠失敗。
 * 不通過的欄位丟掉並記下原因，不影響其他欄位。順序：install → test → checks，因為 test 與 checks 可能需要先安裝。
 */
export async function validateProposal(p: DetectionProposal, deps: ValidateDeps): Promise<Validated> {
  const dropped: Validated["dropped"] = [];
  const out: Validated = { checks: [], dropped, profileExtras: {} };
  if (p.install !== undefined) {
    const v = await tryCommand(p.install, deps);
    if (v.ok) out.install = p.install;
    else dropped.push({ field: "install", reason: v.reason });
  }
  let passedTest: string | undefined;
  if (p.test !== undefined) {
    const v = await tryCommand(p.test, deps);
    if (v.ok) passedTest = p.test;
    else dropped.push({ field: "test", reason: v.reason });
  }
  for (const check of p.checks ?? []) {
    const v = await tryCommand(check.cmd, deps);
    if (v.ok) out.checks.push(check);
    else dropped.push({ field: `checks.${check.name}`, reason: v.reason });
  }
  if (p.testPattern !== undefined) {
    try {
      const re = new RegExp(p.testPattern);
      const testish = deps.files.filter((f) => /test|spec/i.test(f));
      if (testish.length > 0 && !testish.some((f) => re.test(f))) {
        dropped.push({ field: "testPattern", reason: `專案已有測試檔，但沒有任何一個符合：${p.testPattern}` });
      } else {
        out.testPattern = p.testPattern;
      }
    } catch {
      dropped.push({ field: "testPattern", reason: `不是合法的正規表示式：${p.testPattern}` });
    }
  }
  const extras: ProfileExtras = {};
  const checkPattern = (field: string, x: { pattern: string; example: string }): string | undefined => {
    try {
      if (new RegExp(x.pattern).test(x.example)) return x.pattern;
      dropped.push({ field, reason: `範例沒有被這個規則比對到：${x.pattern}` });
    } catch {
      dropped.push({ field, reason: `不是合法的正規表示式：${x.pattern}` });
    }
    return undefined;
  };
  const listOf = (field: "skipPatterns" | "suppressPatterns") => (p[field] ?? []).map((x) => checkPattern(field, x)).filter((x): x is string => x !== undefined);
  const skip = listOf("skipPatterns");
  if (skip.length) extras.skipPatterns = skip;
  const suppress = listOf("suppressPatterns");
  if (suppress.length) extras.suppressPatterns = suppress;
  const assertPattern = p.assertPattern && checkPattern("assertPattern", p.assertPattern);
  if (assertPattern) extras.assertPattern = assertPattern;
  const failureLine = p.failureLine && checkPattern("failureLine", p.failureLine);
  if (failureLine) extras.failureLine = failureLine;
  if (p.failureFormat) extras.failureFormat = p.failureFormat;
  for (const field of ["depDirs", "skipDirs"] as const) {
    const ok: string[] = [];
    for (const d of p[field] ?? []) {
      if (!isSafeDirName(d)) dropped.push({ field, reason: `不是單一層的目錄名稱：${JSON.stringify(d)}` });
      else if (field === "depDirs" && !isSafeDepDirName(d)) dropped.push({ field, reason: `是 agentflowctl 或 git 保留的目錄，不能當依賴目錄：${d}` });
      else if (field === "depDirs" && deps.files.some((f) => f === d || f.startsWith(`${d}/`))) dropped.push({ field, reason: `已被版控追蹤，不能當依賴目錄：${d}` });
      else if (!deps.dirOk(d, field)) dropped.push({ field, reason: field === "depDirs" ? `不是已存在的目錄：${d}` : `不是目錄，也沒有被 .gitignore 忽略：${d}` });
      else ok.push(d);
    }
    if (ok.length) extras[field] = ok;
  }
  if (p.sourceExts?.length) {
    const exts = p.sourceExts.filter((e) => /^\.\w+$/.test(e));
    if (exts.length) extras.sourceExts = exts;
  }
  out.profileExtras = extras;
  if (passedTest !== undefined) {
    if (out.testPattern !== undefined) {
      out.test = passedTest;
    } else {
      // 沒有 testPattern 就無法要求測試檔命名，走紅綠燈會卡死；改當每個任務都跑的一般檢查
      dropped.push({ field: "test", reason: "沒有可用的 testPattern，無法走紅綠燈；改當一般檢查執行" });
      if (!out.checks.some((c) => c.name === "unit-tests")) out.checks.unshift({ name: "unit-tests", cmd: passedTest });
    }
  }
  return out;
}
