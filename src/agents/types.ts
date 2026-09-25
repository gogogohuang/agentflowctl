/** 各家 agent CLI 輸出的事件，正規化成同一種格式 */
export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: "done"; ok: boolean; summary?: string };

export interface InvokeOptions {
  prompt: string;
  cwd: string;
  model?: string;
  extraArgs: string[];
  /** 這個 run 的資料目錄，adapter 可以在這裡寫設定檔 */
  runDir: string;
  /** 主專案根目錄（worktree 的上層），用來禁止 agent 修改主專案的 .git */
  projectRoot: string;
  /** command adapter 使用：自訂指令，`{prompt}` 會被替換成 prompt */
  command?: string[];
}

export interface Invocation {
  cmd: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

export interface Adapter {
  /** 用來確認 CLI 是否已安裝的指令 */
  probe(command?: string[]): { cmd: string; args: string[] };
  invoke(opts: InvokeOptions): Invocation;
  /** 解析一行 stdout；不認得的行回傳空陣列 */
  parse(line: string): AgentEvent[];
}

export function tryJson(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
