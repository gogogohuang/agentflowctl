import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ADAPTERS, DEFAULT_CYCLE } from "./agents/index.js";
import { AgentDef, type RepoConfig } from "./schemas.js";
import { projectRoot, runDir } from "./paths.js";
import { exec, execShell } from "./proc.js";
import { tail } from "./util.js";

export interface AgentTarget {
  runId: string;
  cwd: string;
  logFile: string;
}

/** 會讓各家 CLI 改走 API 計費的環境變數；訂閱登入模式下執行 agent 時會移除 */
export const API_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

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

export interface AgentResult {
  /** 因額度或速率限制而失敗 */
  quotaExhausted: boolean;
  ok: boolean;
  summary: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function appendLog(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

/** 內建的 claude、codex、gemini 定義，可在 flow.config.json 覆寫或新增其他 agent */
export function resolveAgent(cfg: RepoConfig, name: string): AgentDef {
  const custom = cfg.agents[name];
  if (custom) return custom;
  if ((DEFAULT_CYCLE as readonly string[]).includes(name)) {
    return AgentDef.parse({ adapter: name });
  }
  throw new Error(`未定義的 agent：${name}（請在 flow.config.json 的 agents 裡設定）`);
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
  opts: { stripApiKeys: boolean },
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
  appendLog(t.logFile, `# agent=${name} adapter=${def.adapter} cmd=${inv.cmd}`);

  let done: { ok: boolean; summary?: string } | undefined;
  let lastText = "";
  let costUsd: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  const r = await exec(inv.cmd, inv.args, {
    cwd: t.cwd,
    env: inv.env,
    unsetEnv: opts.stripApiKeys ? API_KEY_VARS : [],
    input: inv.input,
    onStdoutLine: (line) => {
      if (!line.trim()) return;
      appendLog(t.logFile, line);
      for (const ev of adapter.parse(line)) {
        if (ev.kind === "text") {
          lastText = ev.text;
          console.log(`    💬 [${name}] ${ev.text.trim().split("\n")[0]?.slice(0, 110)}`);
        } else if (ev.kind === "tool") {
          console.log(`    🔧 [${name}] ${ev.name}`);
        } else if (ev.kind === "usage") {
          inputTokens += ev.inputTokens ?? 0;
          outputTokens += ev.outputTokens ?? 0;
          if (ev.costUsd !== undefined) costUsd = (costUsd ?? 0) + ev.costUsd;
        } else if (ev.kind === "done") {
          done = { ok: ev.ok, summary: ev.summary };
        }
      }
    },
  });
  if (r.stderr.trim()) appendLog(t.logFile, `[stderr]\n${r.stderr}`);

  // CLI 沒回報花費時，用設定的價格從 token 數估算
  if (costUsd === undefined && def.pricing) {
    costUsd = (inputTokens * def.pricing.inputPerMTok + outputTokens * def.pricing.outputPerMTok) / 1_000_000;
  }
  const ok = r.code === 0 && (done?.ok ?? true);
  const summary = done?.summary || lastText || tail(r.stdout, 2000) || tail(r.stderr, 2000);
  const quotaExhausted = !ok && isQuotaError(`${summary}\n${done?.summary ?? ""}\n${r.stderr}\n${tail(r.stdout, 4000)}`);
  return { ok, quotaExhausted, summary, costUsd: costUsd ?? 0, inputTokens, outputTokens };
}

/**
 * 在 worktree 內執行專案指令（安裝、測試、建置）。
 * 注意：這些指令會執行 agent 寫出來的程式碼，而且不在任何沙箱內。
 */
export async function runCommand(t: AgentTarget, cmd: string): Promise<{ ok: boolean; output: string }> {
  appendLog(t.logFile, `$ ${cmd}`);
  const r = await execShell(cmd, { cwd: t.cwd });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  appendLog(t.logFile, output);
  return { ok: r.code === 0, output };
}
