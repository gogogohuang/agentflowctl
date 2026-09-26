import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ADAPTERS } from "./agents/index.js";
import type { AgentDef, RepoConfig } from "./schemas.js";
import { projectRoot, runDir } from "./paths.js";
import { config } from "./config.js";
import { CMD_AGENT, footerLine, headerLine, logSeq, STDERR_MARK } from "./logs.js";
import { exec, execShell } from "./proc.js";
import { tail } from "./util.js";

export interface AgentTarget {
  runId: string;
  cwd: string;
  /** 由 nextLogFile 產生；檔頭會記下 stage 與 step */
  logFile: string;
  stage: string;
  step: string;
}

/**
 * 判斷 agent 失敗是否因為方案額度或速率限制。
 * 各家的錯誤訊息會隨版本變動，這裡用寬鬆的樣式比對，且只在執行失敗時才檢查，避免誤判正常輸出。
 */
const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /quota/i,
  /resource[_ ]exhausted/i,
  /limit reached/i,
  /too many requests/i,
  /hit your (usage )?limit/i,
  /\b429\b/,
];

export const isQuotaError = (text: string) => QUOTA_PATTERNS.some((p) => p.test(text));

/** Agent 回覆結尾的 <result> 中繼資料（格式定義在各 prompt 的 <reply_format>） */
export const ResultMeta = z.object({
  status: z.enum(["done", "blocked"]),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  concerns: z.string().default(""),
});
export type ResultMeta = z.infer<typeof ResultMeta>;

const tagText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

/** 取回覆中最後一個 <result> 區塊；沒有或格式不合時回傳 undefined，不影響關卡判斷 */
export function parseResultMeta(text: string): ResultMeta | undefined {
  const block = [...text.matchAll(/<result>([\s\S]*?)<\/result>/g)].at(-1)?.[1];
  if (block === undefined) return undefined;
  const files = tagText(block, "files_changed") ?? "";
  const parsed = ResultMeta.safeParse({
    status: tagText(block, "status"),
    summary: tagText(block, "summary"),
    filesChanged: [...files.matchAll(/<file>([\s\S]*?)<\/file>/g)].map((m) => m[1]!.trim()).filter(Boolean),
    concerns: tagText(block, "concerns"),
  });
  return parsed.success ? parsed.data : undefined;
}

export interface AgentResult {
  /** 因額度或速率限制而失敗 */
  quotaExhausted: boolean;
  ok: boolean;
  summary: string;
  /** 回覆裡的 XML 中繼資料；agent 沒附上時為 undefined */
  meta?: ResultMeta;
  inputTokens: number;
  outputTokens: number;
}

function appendLog(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

/** 一行工具事件的畫面輸出：完整顯示指令或參數，多行時後續行縮排對齊 */
export function formatToolLine(agent: string, tool: { name: string; detail?: string }): string {
  const head = `    🔧 [${agent}] ${tool.name}`;
  const detail = tool.detail?.trim();
  return detail ? `${head}: ${detail.split("\n").join("\n       ")}` : head;
}

/** 取出 flow.config.json 裡定義的 agent；沒有內建 agent */
export function resolveAgent(cfg: RepoConfig, name: string): AgentDef {
  const def = cfg.agents[name];
  if (!def) throw new Error(`未定義的 agent：${name}（請先用 agent add ${name} --adapter <adapter> 新增）`);
  const defaultModel = def.adapter === "command" ? undefined : cfg.defaultModels[def.adapter];
  return { ...def, model: def.model ?? defaultModel };
}

/** 確認某個 agent 的 CLI 是否可以執行 */
export async function probeAgent(def: AgentDef): Promise<boolean> {
  const { cmd, args } = ADAPTERS[def.adapter].probe(def.command);
  try {
    return (await exec(cmd, args)).code === 0;
  } catch {
    return false;
  }
}

/** 執行任一家的 agent CLI，把輸出正規化成同一種結果 */
export async function runAgent(
  name: string,
  def: AgentDef,
  t: AgentTarget,
  prompt: string,
): Promise<AgentResult> {
  const adapter = ADAPTERS[def.adapter];
  const inv = adapter.invoke({
    prompt,
    cwd: t.cwd,
    model: def.model,
    extraArgs: def.extraArgs,
    runDir: runDir(t.runId),
    projectRoot: projectRoot(),
    command: def.command,
  });
  appendLog(t.logFile, headerLine({ stage: t.stage, step: t.step, agent: name, adapter: def.adapter, startedAt: new Date().toISOString() }));

  let done: { ok: boolean; summary?: string } | undefined;
  let lastText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const r = await exec(inv.cmd, inv.args, {
    cwd: t.cwd,
    env: inv.env,
    input: inv.input,
    onStdoutLine: (line) => {
      if (!line.trim()) return;
      appendLog(t.logFile, line);
      for (const ev of adapter.parse(line)) {
        if (ev.kind === "text") {
          lastText = ev.text;
          if (config.verbose) console.log(`    💬 [${name}] ${ev.text.trim().split("\n")[0]?.slice(0, 110)}`);
        } else if (ev.kind === "tool") {
          if (config.verbose) console.log(formatToolLine(name, ev));
        } else if (ev.kind === "usage") {
          inputTokens += ev.inputTokens ?? 0;
          outputTokens += ev.outputTokens ?? 0;
        } else if (ev.kind === "done") {
          done = { ok: ev.ok, summary: ev.summary };
        }
      }
    },
  });
  if (r.stderr.trim()) appendLog(t.logFile, `${STDERR_MARK}\n${r.stderr}`);

  const ok = r.code === 0 && (done?.ok ?? true);
  appendLog(t.logFile, footerLine({ code: r.code, ok, endedAt: new Date().toISOString() }));
  if (!ok) console.log(`    ✗ ${name} 執行失敗（結束碼 ${r.code}），可用 agentflowctl logs ${t.runId} ${logSeq(t.logFile)} 查看`);
  const summary = done?.summary || lastText || tail(r.stdout, 2000) || tail(r.stderr, 2000);
  const quotaExhausted = !ok && isQuotaError(`${summary}\n${done?.summary ?? ""}\n${r.stderr}\n${tail(r.stdout, 4000)}`);
  const meta = parseResultMeta(summary) ?? parseResultMeta(lastText);
  return { ok, quotaExhausted, summary, meta, inputTokens, outputTokens };
}

/**
 * 在 worktree 內執行專案指令（安裝、測試、建置）。
 * 注意：這些指令會執行 agent 寫出來的程式碼，而且不在任何沙箱內。
 */
export async function runCommand(t: AgentTarget, cmd: string): Promise<{ ok: boolean; output: string; seq: number }> {
  appendLog(t.logFile, headerLine({ stage: t.stage, step: t.step, agent: CMD_AGENT, startedAt: new Date().toISOString() }));
  appendLog(t.logFile, `$ ${cmd}`);
  if (config.verbose) console.log(`    $ ${cmd.trim().split("\n").join("\n      ")}`);
  const r = await execShell(cmd, { cwd: t.cwd });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  if (output) appendLog(t.logFile, output);
  appendLog(t.logFile, footerLine({ code: r.code, ok: r.code === 0, endedAt: new Date().toISOString() }));
  return { ok: r.code === 0, output, seq: logSeq(t.logFile) };
}
