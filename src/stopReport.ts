import { join } from "node:path";
import { summarizeLog, type LogEntry } from "./logs.js";
import type { FlowRun, HandoffIssue } from "./schemas.js";

export interface StopReportInput {
  run: FlowRun;
  /** 依序號排好的 log 列表（只含檔頭與檔尾） */
  logs: LogEntry[];
  read: (file: string) => string;
  /** 還沒結案的交接事項 */
  open: HandoffIssue[];
  worktree: string;
  /** 由 Ctrl-C 觸發 */
  interrupted?: boolean;
}

const pad = (s: string) => s.split("\n").join("\n     ");
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…`);

/** 一份 log 的結果：標題、<result> 的摘要與疑慮；失敗時附上錯誤整理 */
function outcomeLines(entry: LogEntry, text: string): string[] {
  const s = summarizeLog(text);
  const mark = s.ok === undefined ? "…" : s.ok ? "✓" : "✗";
  const out = [`  #${entry.seq} ${s.title} ${mark}`];
  if (s.meta) {
    if (s.meta.status === "blocked") out.push("     狀態：blocked");
    if (s.meta.summary) out.push(`     摘要：${pad(s.meta.summary)}`);
    if (s.meta.concerns) out.push(`     疑慮：${pad(s.meta.concerns)}`);
  } else if (s.text) {
    out.push(`     ${pad(s.text)}`);
  }
  for (const e of s.errors) out.push(`     ${pad(clip(e, 1500))}`);
  return out;
}

/**
 * run 停下來（Ctrl-C、失敗、暫停、等待核准）時要直接印在終端機的內容：
 * 最近一步的結果、未結交接事項，以及接下來可以執行的指令。完成的 run 不印。
 */
export function stopReport(i: StopReportInput): string[] {
  const { run, logs } = i;
  if (run.stage === "done") return [];
  const out: string[] = [];

  const last = logs.at(-1);
  const running = last && !last.footer ? last : undefined;
  const finished = logs.filter((e) => e.footer);
  const lastFailed = finished.filter((e) => !e.footer!.ok).at(-1);
  // 失敗時優先看失敗的那一步，其餘情況看最後完成的一步
  const shown = run.stage === "failed" && lastFailed ? lastFailed : finished.at(-1);

  if (running || shown) {
    out.push("", "── 結果 ──");
    if (running) {
      const title = summarizeLog(i.read(running.file)).title;
      out.push(`  ${i.interrupted ? "中斷於" : "進行中"} #${running.seq} ${title}（沒有結束紀錄，resume 時會重跑這一步）`);
    }
    if (shown) out.push(...outcomeLines(shown, i.read(shown.file)));
  }

  if (i.open.length) {
    out.push("", "── 未結交接事項 ──");
    for (const item of i.open) out.push(`  [${item.targetStage}] ${item.id} ${item.summary}（${item.status}）`);
  }

  const cmd = (c: string, why: string) => `  ${c.padEnd(40)} ${why}`;
  const actions: string[] = [];
  if (run.stage === "failed") {
    if (lastFailed) actions.push(cmd(`agentflowctl logs ${run.id} ${lastFailed.seq}`, "看失敗步驟的完整 log"));
    actions.push(cmd(`cd ${i.worktree}`, "需要時手動修正"));
    actions.push(cmd(`agentflowctl resume ${run.id}`, `從 ${run.failedStage ?? "失敗的階段"} 重試`));
    actions.push(cmd(`agentflowctl cancel ${run.id}`, "放棄這個 run"));
  } else if (run.stage === "paused") {
    actions.push(cmd(`agentflowctl resume ${run.id}`, "額度恢復後接續"));
  } else if (run.stage === "awaiting_approval") {
    actions.push(cmd(`less ${join(i.worktree, ".flow", "plan.md")}`, "檢視計畫"));
    actions.push(cmd(`agentflowctl approve ${run.id}`, "核准並開始實作"));
  } else {
    if (shown) actions.push(cmd(`agentflowctl logs ${run.id} ${shown.seq}`, "看上一步的完整 log"));
    actions.push(cmd(`agentflowctl resume ${run.id}`, `從 ${run.stage} 接續`));
    actions.push(cmd(`agentflowctl cancel ${run.id}`, "放棄這個 run"));
  }
  out.push("", "── 下一步 ──", ...actions);
  return out;
}
