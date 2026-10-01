/** 各家 agent CLI 輸出的事件，正規化成同一種格式 */
export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; /** 完整的指令或主要參數（shell 指令、檔案路徑……），不截斷 */ detail?: string }
  | {
      kind: "usage";
      /** 全部送入的 token，含 cache 讀取與寫入 */
      inputTokens?: number;
      outputTokens?: number;
      /** inputTokens 中讀取 cache 的部分 */
      cacheReadTokens?: number;
      /** inputTokens 中寫入 cache 的部分 */
      cacheWriteTokens?: number;
    }
  | { kind: "model"; id: string }
  /** CLI 回報但不影響執行結果的錯誤，例如缺少模型 metadata 改用預設值 */
  | { kind: "warning"; message: string }
  | { kind: "done"; ok: boolean; summary?: string };

export interface InvokeOptions {
  prompt: string;
  cwd: string;
  model?: string;
  /** 推理強度；只有 claude 與 codex 使用 */
  effort?: string;
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
  /** 實際模型可用性檢查；無法強制停用工具的 adapter 不提供。 */
  invokeModelProbe?(model: string, cwd: string, effort?: string): Invocation;
  /** 模型探測時解析一行 stdout；可以比 parse 更嚴格（例如尚未完成的工具也算），未提供時用 parse */
  parseModelProbe?(line: string): AgentEvent[];
  /** 從模型探測的 stderr 找出讓驗證失敗的診斷，回傳失敗原因 */
  modelProbeFailure?(stderr: string): string | undefined;
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
