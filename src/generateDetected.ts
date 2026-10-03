import type { DetectedFile, DetectionProposal } from "./schemas.js";

export interface ValidateDeps {
  /** 在臨時 worktree 內跑指令；逾時要回傳 ok: false */
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  /** 臨時 worktree 內追蹤檔的相對路徑 */
  files: string[];
  /** 指令的第一個可執行檔是否存在 */
  hasExecutable(bin: string): boolean;
}

export type Validated = Pick<DetectedFile, "install" | "test" | "checks" | "testPattern" | "dropped">;

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
  return result.ok ? { ok: true } : { ok: false, reason: `在基底上沒有通過：${cmd}` };
}

/**
 * 逐欄位驗證 agent 的提案；原則是「基底 commit 上必須是綠的」，否則 verify 會永遠失敗。
 * 不通過的欄位丟掉並記下原因，不影響其他欄位。順序：install → test → checks，因為 test 與 checks 可能需要先安裝。
 */
export async function validateProposal(p: DetectionProposal, deps: ValidateDeps): Promise<Validated> {
  const dropped: Validated["dropped"] = [];
  const out: Validated = { checks: [], dropped };
  if (p.install !== undefined) {
    const v = await tryCommand(p.install, deps);
    if (v.ok) out.install = p.install;
    else dropped.push({ field: "install", reason: v.reason });
  }
  if (p.test !== undefined) {
    const v = await tryCommand(p.test, deps);
    if (v.ok) out.test = p.test;
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
  return out;
}
