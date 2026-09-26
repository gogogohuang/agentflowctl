import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "./agents/index.js";
import type { AgentEvent } from "./agents/types.js";
import { str, tryJson } from "./agents/types.js";

/**
 * 每次執行 agent 或專案指令都寫成一份 log：
 * - 檔名：<三位數序號>-<階段>-<步驟>-<agent>.log，專案指令的 agent 欄位是 cmd
 * - 第一行：`# agentflowctl {...}`，記錄階段、步驟、agent、開始時間
 * - 中間：agent 的原始 stdout（JSON 行）或指令輸出，原樣保存；stderr 接在 `[stderr]` 之後
 * - 最後一行：`# exit {...}`，記錄結束碼與是否成功；沒有這行代表還在執行或被中斷
 */
export const HEADER_PREFIX = "# agentflowctl ";
export const FOOTER_PREFIX = "# exit ";
export const STDERR_MARK = "[stderr]";
/** 專案指令（install、測試、checks）的 agent 欄位 */
export const CMD_AGENT = "cmd";

export interface LogHeader {
  stage: string;
  step: string;
  agent: string;
  adapter?: string;
  startedAt: string;
}

export interface LogFooter {
  code: number;
  ok: boolean;
  endedAt: string;
}

const segment = (s: string) => s.replace(/[\s/\\:*?"<>|]+/g, "_");

/** 下一份 log 的完整路徑；序號接在目錄裡最大的序號之後 */
export function nextLogFile(dir: string, stage: string, step: string, agent: string): string {
  const seqs = existsSync(dir) ? readdirSync(dir).map((f) => Number(f.match(/^(\d+)-/)?.[1] ?? 0)) : [];
  const seq = Math.max(0, ...seqs) + 1;
  return join(dir, `${String(seq).padStart(3, "0")}-${segment(stage)}-${segment(step)}-${segment(agent)}.log`);
}

export const logSeq = (file: string) => Number(file.split(/[\\/]/).at(-1)?.match(/^(\d+)-/)?.[1] ?? 0);

export const headerLine = (h: LogHeader) => `${HEADER_PREFIX}${JSON.stringify(h)}`;
export const footerLine = (f: LogFooter) => `${FOOTER_PREFIX}${JSON.stringify(f)}`;

interface ParsedLog {
  header?: LogHeader;
  footer?: LogFooter;
  body: string[];
  stderr: string[];
}

function parseLog(text: string): ParsedLog {
  const out: ParsedLog = { body: [], stderr: [] };
  let inStderr = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(HEADER_PREFIX) && !out.header) out.header = tryJson(line.slice(HEADER_PREFIX.length)) as LogHeader | undefined;
    else if (line.startsWith(FOOTER_PREFIX)) out.footer = tryJson(line.slice(FOOTER_PREFIX.length)) as LogFooter | undefined;
    else if (line === STDERR_MARK) inStderr = true;
    else (inStderr ? out.stderr : out.body).push(line);
  }
  while (out.stderr.at(-1) === "") out.stderr.pop();
  while (out.body.at(-1) === "") out.body.pop();
  return out;
}

export interface LogEntry {
  seq: number;
  file: string;
  header?: LogHeader;
  footer?: LogFooter;
}

/** 依序號列出 run 的所有 log，只讀檔頭與檔尾 */
export function listLogs(dir: string): LogEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d+-.*\.log$/.test(f))
    .map((f) => {
      const file = join(dir, f);
      const { header, footer } = parseLog(readFileSync(file, "utf8"));
      return { seq: logSeq(f), file, header, footer };
    })
    .sort((a, b) => a.seq - b.seq);
}

/** 執行結果：✓ 成功、✗ 失敗、… 沒有檔尾（還在執行或被中斷） */
export const logMark = (e: Pick<LogEntry, "footer">) => (!e.footer ? "…" : e.footer.ok ? "✓" : "✗");

/** ISO 時間轉成本地時間 YYYY-MM-DD HH:mm:ss */
export function localTime(iso?: string): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return "?";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const clip = (s: string, max = 800) => (s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字）`);
const indent = (s: string, pad = "   ") => s.split("\n").join(`\n${pad}`);

/** 從沒被 adapter 認得的 JSON 事件裡找錯誤：頂層的 error 類事件算失敗，工具回報的錯誤只當作提示 */
function findError(ev: Record<string, unknown>): { message: string; fatal: boolean } | undefined {
  const pick = (o: Record<string, unknown>) => {
    const err = o.error;
    const nested = err && typeof err === "object" ? str((err as Record<string, unknown>).message) : undefined;
    const content = Array.isArray(o.content)
      ? o.content.map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).text) : str(c))).filter(Boolean).join("\n")
      : str(o.content);
    return nested ?? str(err) ?? str(o.message) ?? (content || undefined) ?? str(o.result) ?? JSON.stringify(o);
  };
  if (ev.is_error === true || ev.error || /error|fail/i.test(str(ev.type) ?? "") || /error|fail/i.test(str(ev.subtype) ?? "")) {
    return { message: clip(pick(ev)), fatal: true };
  }
  const walk = (v: unknown, depth: number): Record<string, unknown> | undefined => {
    if (!v || typeof v !== "object" || depth > 4) return undefined;
    if (!Array.isArray(v) && (v as Record<string, unknown>).is_error === true) return v as Record<string, unknown>;
    for (const child of Object.values(v)) {
      const hit = walk(child, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  const hit = walk(ev, 0);
  return hit ? { message: clip(pick(hit)), fatal: false } : undefined;
}

/** worktree 絕對路徑改成相對路徑：`<worktree>/x` → `x`，單獨的 `<worktree>` → `.` */
const relativeToWorktree = (s: string) =>
  s.replace(/[^\s'"=]*\/\.agentflowctl\/worktrees\/[^/\s'"]+(\/)?/g, (_m, slash?: string) => (slash ? "" : "."));

/** 去掉 codex 這類 CLI 包在指令外面的 `/bin/zsh -lc '...'` */
function unwrapShell(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (!m) return cmd;
  const [, quote, inner] = m;
  // 單引號包裝裡的 '"'"' 或 '\'' 是被跳脫的單引號，內容太複雜時保留原樣
  if (quote === "'" && inner!.includes("'")) return cmd;
  if (quote === '"' && /(^|[^\\])"/.test(inner!)) return cmd;
  return inner!;
}

/** 精簡顯示的工具內容：只留第一行，並註明原本有幾行 */
function compactDetail(detail: string): string {
  const lines = relativeToWorktree(unwrapShell(detail.trim())).split("\n");
  const first = clip(lines[0]!, 200);
  return lines.length > 1 ? `${first}　…（共 ${lines.length} 行）` : first;
}

function renderEvent(ev: AgentEvent, full: boolean, lastText?: string): string | undefined {
  switch (ev.kind) {
    case "text":
      return `💬 ${indent(ev.text.trim())}`;
    case "tool": {
      const detail = ev.detail?.trim();
      if (!detail) return `🔧 ${ev.name}`;
      return `🔧 ${ev.name}: ${full ? indent(detail) : compactDetail(detail)}`;
    }
    case "usage":
      return `📊 用量 input ${ev.inputTokens ?? "?"} / output ${ev.outputTokens ?? "?"} tokens`;
    case "done": {
      const summary = ev.summary?.trim();
      // 最後一則回覆通常就是 summary，精簡模式不再重印一次
      const show = summary && (full || summary !== lastText);
      return `🏁 ${ev.ok ? "完成" : "失敗"}${show ? `：${indent(summary)}` : ""}`;
    }
  }
}

export interface RenderOptions {
  /** 顯示完整的工具內容與重複的最後回覆 */
  full?: boolean;
}

/** 把一份 log 轉成人看得懂的版本；最後附上錯誤整理，讓失敗原因一眼可見。預設精簡工具內容，opts.full 時完整顯示 */
export function renderLog(text: string, file = "", opts: RenderOptions = {}): string {
  const { header, footer, body, stderr } = parseLog(text);
  const out: string[] = [];
  const errors: string[] = [];
  const title = header
    ? `${header.stage} / ${header.step} / ${header.agent}${header.adapter && header.adapter !== header.agent ? `（adapter ${header.adapter}）` : ""}`
    : "（沒有檔頭）";
  out.push(`${logSeq(file) ? `#${logSeq(file)}  ` : ""}${title}`);
  out.push(
    `開始 ${localTime(header?.startedAt)}　` +
      (footer ? `結束 ${localTime(footer.endedAt)}　結束碼 ${footer.code}　${footer.ok ? "✓ 成功" : "✗ 失敗"}` : "… 沒有結束紀錄（還在執行或被中斷）"),
  );
  if (file) out.push(`檔案 ${file}`);
  out.push("");

  const adapter = header?.adapter ? ADAPTERS[header.adapter as keyof typeof ADAPTERS] : undefined;
  if (!adapter || header?.agent === CMD_AGENT) {
    out.push(...body);
  } else {
    let skipped = 0;
    let lastText: string | undefined;
    for (const line of body) {
      if (!line.trim()) continue;
      const events = adapter.parse(line);
      if (events.length) {
        for (const ev of events) {
          const s = renderEvent(ev, opts.full ?? false, lastText);
          if (s) out.push(s);
          if (ev.kind === "text") lastText = ev.text.trim();
          if (ev.kind === "done" && !ev.ok) errors.push(`agent 回報失敗${ev.summary ? `：${indent(ev.summary.trim())}` : ""}`);
        }
        continue;
      }
      const json = tryJson(line);
      if (!json) {
        out.push(`📄 ${line}`);
        continue;
      }
      const err = findError(json);
      if (!err) {
        skipped++;
        continue;
      }
      out.push(`${err.fatal ? "❌" : "⚠️ "} ${indent(err.message)}`);
      if (err.fatal) errors.push(`錯誤事件：${indent(err.message)}`);
    }
    if (skipped) out.push(`（另有 ${skipped} 行其他事件未顯示，可用 --raw 查看）`);
  }

  if (footer && footer.code !== 0) errors.unshift(`結束碼 ${footer.code}`);
  if (footer && !footer.ok && !errors.length) errors.push("執行未通過（沒有更多錯誤訊息）");
  const stderrText = stderr.length ? `stderr：\n   ${indent(clip(stderr.join("\n"), 4000))}` : undefined;

  if (errors.length) out.push("", "── 錯誤 ──", ...errors, ...(stderrText ? [stderrText] : []));
  else if (stderrText) out.push("", "── 其他輸出 ──", stderrText);
  return out.join("\n");
}
