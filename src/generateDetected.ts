import { tail } from "./util.js";
import type { ProfileExtras } from "./profile.js";
import type { DetectedFile, DetectionProposal } from "./schemas.js";

export interface ValidateDeps {
  /** 在臨時 worktree 內跑指令；逾時要回傳 ok: false */
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  /** 臨時 worktree 內追蹤檔的相對路徑 */
  files: string[];
  /** 指令的第一個可執行檔是否存在 */
  hasExecutable(bin: string): boolean;
  /** 目錄存在，或已被 .gitignore 忽略（依賴目錄通常不進版控） */
  dirOk(dir: string): boolean;
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
    const ok = (p[field] ?? []).filter((d) => deps.dirOk(d));
    const bad = (p[field] ?? []).filter((d) => !deps.dirOk(d));
    if (ok.length) extras[field] = ok;
    if (bad.length) dropped.push({ field, reason: `不存在也沒有被 .gitignore 忽略：${bad.join("、")}` });
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
