import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parallelReviewDir } from "./paths.js";
import { HandoffLedger } from "./schemas.js";

/**
 * 依序啟動、同時最多 limit 個；結果依輸入順序回傳。
 * fn 丟例外時，其餘已啟動與待啟動的項目仍會跑完（讓它們的收尾，例如移除臨時 worktree，都能完成），最後才把第一個例外丟出。
 */
export async function runPool<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * 一次已執行成功的審查呼叫。放在 run 目錄（worktree 外），以輪次＋輸入指紋為鍵記憶化：
 * 中斷後 resume、或同一輪因別的呼叫失敗而重跑時直接沿用，不重複付費。
 * 只存原始檔案內容：套用時再放回共用的 .flow/，走原有的驗證與交接程式。
 */
export const StoredCall = z.object({
  /** 同一輪內唯一的呼叫識別 */
  key: z.string(),
  reviewer: z.string(),
  agent: z.string(),
  step: z.string(),
  callKey: z.string(),
  summary: z.string(),
  /** 裁決檔原文；agent 沒寫時為 null */
  output: z.string().nullable(),
  /** handoff-response.json 原文；agent 沒寫時為 null */
  handoffResponse: z.string().nullable(),
  /** 這個呼叫啟動時看到的交接帳本：核准門檻以它評估，也用來判斷存檔是否仍可沿用 */
  base: HandoffLedger,
});
export type StoredCall = z.infer<typeof StoredCall>;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const scopeDir = (runId: string, scope: string) => join(parallelReviewDir(runId), scope);

/** 這一輪的存檔目錄；同 scope 下其他指紋（計畫或程式碼已變、輪次已換）的結果一律作廢 */
export function openRound(runId: string, scope: string, fingerprint: string): string {
  const base = scopeDir(runId, scope);
  const mine = hash(fingerprint);
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      if (name !== mine) rmSync(join(base, name), { recursive: true, force: true });
    }
  }
  const dir = join(base, mine);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const callFile = (dir: string, key: string) => join(dir, `${hash(key)}.json`);

export function saveCall(dir: string, call: StoredCall): void {
  const path = callFile(dir, call.key);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(call));
  renameSync(tmp, path);
}

/**
 * 讀出這一輪已存檔的結果，並刪掉寫到一半的 .tmp 與損毀的檔案。
 * 呼叫順序：必須在 runPool 啟動任何呼叫之前；之後才呼叫會刪到別的呼叫正在寫的 .tmp。
 */
export function loadCalls(dir: string): Map<string, StoredCall> {
  const calls = new Map<string, StoredCall>();
  if (!existsSync(dir)) return calls;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!name.endsWith(".json")) {
      rmSync(path, { force: true }); // 寫到一半留下的 .tmp
      continue;
    }
    try {
      const call = StoredCall.parse(JSON.parse(readFileSync(path, "utf8")));
      calls.set(call.key, call);
    } catch {
      rmSync(path, { force: true }); // 損毀或格式不符：當作沒有，重跑
    }
  }
  return calls;
}

export function dropCall(dir: string, key: string): void {
  rmSync(callFile(dir, key), { force: true });
}

/**
 * 存檔是否仍可沿用：帳本在這個呼叫啟動後多出的已套用呼叫，必須全是這一輪已存檔的審查者（崩潰或重跑時已套用的 slot）。
 * 多出別的呼叫（例如修正者只回覆交接、沒改計畫或程式碼，輪次與指紋都沒變）代表審查者沒看過現在的帳本，要重跑。
 */
export function storedCallValid(call: StoredCall, live: HandoffLedger, round: Iterable<StoredCall>): boolean {
  const seen = new Set(call.base.appliedCalls ?? []);
  const sameRound = new Set([...round].map((item) => item.callKey));
  return (live.appliedCalls ?? []).every((key) => seen.has(key) || sameRound.has(key));
}
