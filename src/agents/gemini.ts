import { num, str, toolDetail, tryJson, type Adapter, type AgentEvent } from "./types.js";

/**
 * Google Gemini CLI：`gemini -p ... --output-format stream-json`。
 * Gemini CLI 沒有「只允許工作目錄內的 shell 指令」這種細緻權限，
 * 無人值守時只能用 yolo；需要隔離時請在 extraArgs 加上 `--sandbox`，
 * 或在 CI、容器這類可丟棄的環境中執行。
 */
export const gemini: Adapter = {
  probe: () => ({ cmd: "gemini", args: ["--version"] }),
  invoke: (o) => ({
    cmd: "gemini",
    args: ["-p", o.prompt, "--output-format", "stream-json", "--approval-mode", "yolo", ...(o.model ? ["-m", o.model] : []), ...o.extraArgs],
    env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
  }),
  parse(line) {
    const ev = tryJson(line);
    if (!ev) return [];
    const out: AgentEvent[] = [];
    if (ev.type === "message" && ev.role === "assistant" && str(ev.content)?.trim()) {
      out.push({ kind: "text", text: str(ev.content)! });
    } else if (ev.type === "tool_use") {
      out.push({ kind: "tool", name: str(ev.tool_name) ?? "tool", detail: toolDetail(ev.parameters) });
    } else if (ev.type === "result") {
      const stats = (ev.stats ?? {}) as Record<string, unknown>;
      out.push({
        kind: "usage",
        inputTokens: num(stats.input_tokens) ?? num(stats.inputTokens),
        outputTokens: num(stats.output_tokens) ?? num(stats.outputTokens),
      });
      out.push({ kind: "done", ok: ev.status !== "error", summary: str(ev.response) });
    } else if (ev.type === "error") {
      out.push({ kind: "done", ok: false, summary: str(ev.message) ?? "Gemini 執行失敗" });
    }
    return out;
  },
};
