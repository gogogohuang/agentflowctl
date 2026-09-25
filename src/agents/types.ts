/** 各家 agent CLI 輸出的事件，正規化成同一種格式 */
export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; /** 完整的指令或主要參數（shell 指令、檔案路徑……），不截斷 */ detail?: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number }
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

/** 從工具參數挑出最能代表「正在做什麼」的欄位；都沒有時以 JSON 顯示全部參數 */
export function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "absolute_path", "path", "pattern", "url", "query"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length) return v.join(" ");
  }
  return Object.keys(o).length ? JSON.stringify(o) : undefined;
}
