import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { num, str, toolDetail, tryJson, type Adapter, type AgentEvent, type InvokeOptions } from "./types.js";

/**
 * Claude Code 的權限設定：acceptEdits 只自動允許工作目錄內的修改，
 * 版本控制交給 agentflowctl，並啟用內建沙箱限制 shell 指令。
 * 設定鍵名以 Claude Code 目前的格式撰寫，請依你安裝的版本確認。
 */
function settingsFile(o: InvokeOptions): string {
  const settings = {
    permissions: {
      allow: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(npm:*)", "Bash(npx:*)", "Bash(pnpm:*)", "Bash(node:*)",
        "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"],
      deny: ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git switch:*)",
        "Bash(git rebase:*)", "Bash(git merge:*)", "Bash(git worktree:*)", "Bash(git config:*)", "Bash(git stash:*)",
        "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.config/gh/**)", `Edit(/${join(o.projectRoot, ".git")}/**)`],
    },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
  };
  mkdirSync(o.runDir, { recursive: true });
  const path = join(o.runDir, "claude-settings.json");
  const content = JSON.stringify(settings, null, 2);
  // 平行審查時多個 claude 同時啟動：內容沒變就不寫；要寫時先寫暫存檔再 rename，別的行程不會讀到被截斷的檔案而在沒有 deny list 下執行
  if (existsSync(path) && readFileSync(path, "utf8") === content) return path;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

export const claude: Adapter = {
  probe: () => ({ cmd: "claude", args: ["--version"] }),
  invokeModelProbe: (model) => ({
    cmd: "claude",
    args: ["-p", "只回答 OK", "--model", model, "--output-format", "stream-json", "--verbose",
      "--tools", "", "--strict-mcp-config", "--disable-slash-commands"],
  }),
  invoke: (o) => ({
    cmd: "claude",
    args: [
      "-p", o.prompt,
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits",
      "--settings", settingsFile(o),
      ...(o.model ? ["--model", o.model] : []),
      ...o.extraArgs,
    ],
  }),
  parse(line) {
    const ev = tryJson(line);
    if (!ev) return [];
    const out: AgentEvent[] = [];
    if (ev.type === "system" && ev.subtype === "init" && str(ev.model)) {
      out.push({ kind: "model", id: str(ev.model)! });
    } else if (ev.type === "assistant") {
      const content = (ev.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
      for (const b of content) {
        if (b.type === "text" && str(b.text)?.trim()) out.push({ kind: "text", text: str(b.text)! });
        if (b.type === "tool_use") out.push({ kind: "tool", name: str(b.name) ?? "tool", detail: toolDetail(b.input) });
      }
    } else if (ev.type === "result") {
      const usage = (ev.usage ?? {}) as Record<string, unknown>;
      // Claude 的 input_tokens 不含 cache，要加回來才是實際送入量
      const input = num(usage.input_tokens);
      const cacheRead = num(usage.cache_read_input_tokens);
      const cacheWrite = num(usage.cache_creation_input_tokens);
      if (input !== undefined || num(usage.output_tokens) !== undefined) {
        out.push({
          kind: "usage",
          inputTokens: input === undefined ? undefined : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
          outputTokens: num(usage.output_tokens),
          ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
          ...(cacheWrite !== undefined && { cacheWriteTokens: cacheWrite }),
        });
      }
      out.push({ kind: "done", ok: ev.is_error !== true, summary: str(ev.result) });
    }
    return out;
  },
};
