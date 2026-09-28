import { CMD_AGENT, type LogEntry } from "./logs.js";

export interface StepStat {
  step: string;
  /** agent：呼叫 agent CLI；cmd：install、測試、checks 等專案指令 */
  kind: "agent" | "cmd";
  runs: number;
  /** 有檔尾但未通過的次數 */
  failed: number;
  /** 沒有檔尾（還在執行或被中斷），不計入耗時 */
  unfinished: number;
  totalMs: number;
  maxMs: number;
}

export interface RunStats {
  /** 依總耗時由高到低排序 */
  steps: StepStat[];
  agentMs: number;
  cmdMs: number;
  /** 第一步開始到最後一步結束；中間的暫停、等待核准也算在內 */
  wallMs: number;
  unfinished: number;
}

const time = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/** 從 log 的檔頭與檔尾算出每個步驟的次數、失敗與耗時，不讀 log 內容 */
export function computeStats(entries: LogEntry[]): RunStats {
  const byKey = new Map<string, StepStat>();
  let agentMs = 0;
  let cmdMs = 0;
  let unfinished = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const { header, footer } of entries) {
    if (!header) continue;
    const kind = header.agent === CMD_AGENT ? "cmd" : "agent";
    const key = `${kind}:${header.step}`;
    const s = byKey.get(key) ?? { step: header.step, kind, runs: 0, failed: 0, unfinished: 0, totalMs: 0, maxMs: 0 };
    byKey.set(key, s);
    s.runs += 1;
    const start = time(header.startedAt);
    const end = time(footer?.endedAt);
    if (!footer || Number.isNaN(start) || Number.isNaN(end)) {
      s.unfinished += 1;
      unfinished += 1;
      continue;
    }
    if (!footer.ok) s.failed += 1;
    const ms = Math.max(0, end - start);
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (kind === "cmd") cmdMs += ms;
    else agentMs += ms;
    first = Math.min(first, start);
    last = Math.max(last, end);
  }
  const steps = [...byKey.values()].sort((a, b) => b.totalMs - a.totalMs);
  return { steps, agentMs, cmdMs, wallMs: last > first ? last - first : 0, unfinished };
}

export interface MergedStats {
  steps: StepStat[];
  agentMs: number;
  cmdMs: number;
  unfinished: number;
}

export function mergeStats(runs: RunStats[]): MergedStats {
  const byKey = new Map<string, StepStat>();
  let agentMs = 0;
  let cmdMs = 0;
  let unfinished = 0;
  for (const run of runs) {
    agentMs += run.agentMs;
    cmdMs += run.cmdMs;
    unfinished += run.unfinished;
    for (const s of run.steps) {
      const key = `${s.kind}:${s.step}`;
      const acc = byKey.get(key) ?? { step: s.step, kind: s.kind, runs: 0, failed: 0, unfinished: 0, totalMs: 0, maxMs: 0 };
      acc.runs += s.runs;
      acc.failed += s.failed;
      acc.unfinished += s.unfinished;
      acc.totalMs += s.totalMs;
      acc.maxMs = Math.max(acc.maxMs, s.maxMs);
      byKey.set(key, acc);
    }
  }
  const steps = [...byKey.values()].sort((a, b) => b.failed - a.failed || b.runs - a.runs || b.totalMs - a.totalMs);
  return { steps, agentMs, cmdMs, unfinished };
}

/** 毫秒轉成 1h02m、3m05s、12s */
export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
