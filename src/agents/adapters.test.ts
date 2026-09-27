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

  it("初始化事件回報實際模型時送出 model 事件", () => {
    expect(ADAPTERS.claude.parse('{"type":"system","subtype":"init","cwd":"/w","session_id":"s","tools":[],"model":"claude-opus-5-5","permissionMode":"auto"}'))
      .toEqual([{ kind: "model", id: "claude-opus-5-5" }]);
    expect(ADAPTERS.claude.parse('{"type":"system","subtype":"hook_started","hook_id":"h","session_id":"s"}')).toEqual([]);
    expect(ADAPTERS.gemini.parse('{"type":"init","timestamp":"2026-09-27T08:00:00.000Z","session_id":"s","model":"gemini-2.5-pro"}'))
      .toEqual([{ kind: "model", id: "gemini-2.5-pro" }]);
  });

  it("結束事件沒有 token 數字時不送 usage，runner 才能分辨未回報", () => {
    expect(ADAPTERS.claude.parse('{"type":"result","subtype":"success","is_error":false,"result":"OK"}'))
      .toEqual([{ kind: "done", ok: true, summary: "OK" }]);
    expect(ADAPTERS.codex.parse('{"type":"turn.completed","usage":{}}')).toEqual([]);
    expect(ADAPTERS.gemini.parse('{"type":"result","status":"success","stats":{}}'))
      .toEqual([{ kind: "done", ok: true, summary: undefined }]);
    expect(ADAPTERS.codex.parse('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":3}}'))
      .toEqual([{ kind: "usage", inputTokens: 0, outputTokens: 3 }]);
  });

  it("command：{model} 只代入設定的模型，不留下字面占位符", () => {
    const base = { cwd: "/w", extraArgs: [], runDir: "/r", projectRoot: "/p" };
    expect(ADAPTERS.command.invoke({ ...base, prompt: "P", model: "actual-id", command: ["agent", "--model", "{model}"] }).args)
      .toEqual(["--model", "actual-id"]);
    expect(ADAPTERS.command.invoke({ ...base, prompt: "P", model: "actual-id", command: ["run-{model}"] }).cmd)
      .toBe("run-actual-id");
    expect(() => ADAPTERS.command.invoke({ ...base, prompt: "P", command: ["agent", "--model", "{model}"] })).toThrow(/model/);
    expect(() => ADAPTERS.command.invoke({ ...base, prompt: "P", command: ["run-{model}"] })).toThrow(/model/);
  });
});
