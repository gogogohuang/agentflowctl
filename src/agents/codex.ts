import { num, str, tryJson, type Adapter, type AgentEvent } from "./types.js";

/** 不是工具呼叫的 item；其餘 item（shell、MCP、搜尋、todo……）都當成工具 */
const NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "error"]);

function parse(line: string): AgentEvent[] {
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
    } else if (item.type === "error") {
      // error item 是非致命通知（設定警告、棄用提示、模型改派）；真正的失敗走 turn.failed 或頂層 error
      const message = str(item.message) ?? "Codex 回報錯誤";
      const rerouted = /^model rerouted: \S+ -> (\S+)/.exec(message)?.[1];
      if (rerouted) out.push({ kind: "model", id: rerouted });
      out.push({ kind: "warning", message });
    } else if (typeof item.type === "string" && !NON_TOOL_ITEMS.has(item.type)) {
      out.push({ kind: "tool", name: item.type, detail: str(item.tool) ?? str(item.query) });
    }
  } else if (ev.type === "turn.completed") {
    const usage = (ev.usage ?? {}) as Record<string, unknown>;
    if (num(usage.input_tokens) !== undefined || num(usage.output_tokens) !== undefined) {
      const cacheRead = num(usage.cached_input_tokens);
      out.push({ kind: "usage", inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens),
        ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }) });
    }
    out.push({ kind: "done", ok: true });
  } else if (ev.type === "turn.failed" || ev.type === "error") {
    const err = (ev.error ?? {}) as Record<string, unknown>;
    out.push({ kind: "done", ok: false, summary: str(err.message) ?? str(ev.message) ?? "Codex 執行失敗" });
  }
  return out;
}

/**
 * OpenAI Codex CLI：`codex exec --json`，prompt 由 stdin 傳入（`-`）。
 * workspace-write 沙箱只允許修改工作目錄，且預設不能連網，
 * 所以 agentflowctl 會在建立 worktree 時先幫它裝好相依套件。
 */
export const codex: Adapter = {
  probe: () => ({ cmd: "codex", args: ["--version"] }),
  // Codex 沒有 --tools 空清單；停用可執行工具，剩餘檔案工具由唯讀沙箱限制。
  invokeModelProbe: (model, cwd, effort) => ({
    cmd: "codex",
    args: ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      "--ignore-user-config", "--ignore-rules", "--strict-config", "-C", cwd, "-m", model,
      ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
      "-c", "project_doc_max_bytes=0",
      "-c", "tools.experimental_request_user_input.enabled=false", "-c", "tools.update_plan.enabled=false",
      ...["shell_tool", "hooks", "apps", "plugins", "tool_suggest", "multi_agent", "multi_agent_v2",
        "browser_use", "computer_use", "image_generation", "view_image", "code_mode", "code_mode_host",
        "goals", "memories", "sleep_tool", "unbounded_connection_retries"].flatMap((feature) => ["--disable", feature]), "-"],
    input: "只回答 OK，不要呼叫任何工具。",
  }),
  // 探測也拒絕尚未完成的工具；一般 log 仍在 item.completed 時顯示結果。
  parseModelProbe(line) {
    const out = parse(line);
    const ev = tryJson(line);
    const item = ev?.item as Record<string, unknown> | undefined;
    if (ev?.type === "item.started" && typeof item?.type === "string" && !NON_TOOL_ITEMS.has(item.type)) {
      out.push({ kind: "tool", name: item.type });
    }
    return out;
  },
  // 拒絕 apply_patch 時可能只寫 stderr，沒有 file_change 事件。
  modelProbeFailure: (stderr) =>
    /patch rejected|tools::router.*error=/i.test(stderr) ? `模型檢查期間嘗試呼叫工具：${stderr.trim()}` : undefined,
  invoke: (o) => ({
    cmd: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "-C", o.cwd, ...(o.model ? ["-m", o.model] : []),
      ...(o.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(o.effort)}`] : []), ...o.extraArgs, "-"],
    input: o.prompt,
  }),
  parse,
};
