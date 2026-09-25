import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./index.js";

const j = (o: unknown) => JSON.stringify(o);

describe("adapter 事件解析", () => {
  it("claude：stream-json", () => {
    const { parse } = ADAPTERS.claude;
    expect(parse(j({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit" }] } })))
      .toEqual([{ kind: "text", text: "hi" }, { kind: "tool", name: "Edit" }]);
    expect(parse(j({ type: "result", is_error: false, result: "ok", total_cost_usd: 0.3, usage: { input_tokens: 10, output_tokens: 2 } })))
      .toEqual([{ kind: "usage", inputTokens: 10, outputTokens: 2 }, { kind: "done", ok: true, summary: "ok" }]);
  });

  it("claude：工具事件帶完整指令或參數", () => {
    const { parse } = ADAPTERS.claude;
    const cmd = `pnpm vitest run src/very/long/path/${"x".repeat(120)}.test.ts && echo done`;
    expect(parse(j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } })))
      .toEqual([{ kind: "tool", name: "Bash", detail: cmd }]);
    expect(parse(j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/a.ts", old_string: "a" } }] } })))
      .toEqual([{ kind: "tool", name: "Edit", detail: "/w/a.ts" }]);
  });

  it("codex：exec --json", () => {
    const { parse, invoke } = ADAPTERS.codex;
    expect(parse(j({ type: "item.completed", item: { type: "agent_message", text: "done" } }))).toEqual([{ kind: "text", text: "done" }]);
    expect(parse(j({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } })))
      .toEqual([{ kind: "usage", inputTokens: 5, outputTokens: 1 }]);
    expect(parse(j({ type: "turn.failed", error: { message: "boom" } }))).toEqual([{ kind: "done", ok: false, summary: "boom" }]);
    const cmd = `bash -lc 'pnpm test -- ${"y".repeat(120)}'`;
    expect(parse(j({ type: "item.completed", item: { type: "command_execution", command: cmd } })))
      .toEqual([{ kind: "tool", name: "shell", detail: cmd }]);
    const inv = invoke({ prompt: "P", cwd: "/w", extraArgs: [], runDir: "/r", projectRoot: "/p" });
    expect(inv.input).toBe("P");
    expect(inv.args.at(-1)).toBe("-");
  });

  it("gemini：stream-json", () => {
    const { parse } = ADAPTERS.gemini;
    expect(parse(j({ type: "message", role: "assistant", content: "yo" }))).toEqual([{ kind: "text", text: "yo" }]);
    expect(parse(j({ type: "tool_use", tool_name: "write_file" }))).toEqual([{ kind: "tool", name: "write_file" }]);
    expect(parse(j({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "npm test" } })))
      .toEqual([{ kind: "tool", name: "run_shell_command", detail: "npm test" }]);
    expect(parse(j({ type: "result", status: "error" })).at(-1)).toEqual({ kind: "done", ok: false, summary: undefined });
  });

  it("command：{prompt} 替換，否則改走 stdin", () => {
    const base = { cwd: "/w", extraArgs: [], runDir: "/r", projectRoot: "/p" };
    expect(ADAPTERS.command.invoke({ ...base, prompt: "P", command: ["aider", "--message", "{prompt}"] }))
      .toEqual({ cmd: "aider", args: ["--message", "P"], input: undefined });
    expect(ADAPTERS.command.invoke({ ...base, prompt: "P", command: ["my-agent"] }).input).toBe("P");
    expect(ADAPTERS.claude.parse("not json")).toEqual([]);
  });
});
