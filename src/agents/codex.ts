import { num, str, tryJson, type Adapter, type AgentEvent } from "./types.js";

/**
 * OpenAI Codex CLI：`codex exec --json`，prompt 由 stdin 傳入（`-`）。
 * workspace-write 沙箱只允許修改工作目錄，且預設不能連網，
 * 所以 agentflowctl 會在建立 worktree 時先幫它裝好相依套件。
 */
export const codex: Adapter = {
  probe: () => ({ cmd: "codex", args: ["--version"] }),
  invoke: (o) => ({
    cmd: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "-C", o.cwd, ...(o.model ? ["-m", o.model] : []), ...o.extraArgs, "-"],
    input: o.prompt,
  }),
  parse(line) {
    const ev = tryJson(line);
    if (!ev) return [];
    const out: AgentEvent[] = [];
    if (ev.type === "item.completed") {
      const item = (ev.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && str(item.text)?.trim()) out.push({ kind: "text", text: str(item.text)! });
      else if (item.type === "command_execution") out.push({ kind: "tool", name: "shell", detail: str(item.command) });
      else if (item.type === "file_change") {
        const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
        const paths = changes.map((c) => str(c.path)).filter(Boolean);
        out.push({ kind: "tool", name: "edit", detail: paths.length ? paths.join(", ") : undefined });
      }
    } else if (ev.type === "turn.completed") {
      const usage = (ev.usage ?? {}) as Record<string, unknown>;
      out.push({ kind: "usage", inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) });
    } else if (ev.type === "turn.failed" || ev.type === "error") {
      const err = (ev.error ?? {}) as Record<string, unknown>;
      out.push({ kind: "done", ok: false, summary: str(err.message) ?? str(ev.message) ?? "Codex 執行失敗" });
    }
    return out;
  },
};
