import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./agents/index.js";
import { probeFailureReason, probeModel } from "./modelProbe.js";

describe("模型即時探測", () => {
  it("專用探測參數不沿用一般執行的工具權限", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-probe-args-"));
    const claude = ADAPTERS.claude.invokeModelProbe?.("model-x", dir);
    expect(claude?.args).toContain("--tools");
    expect(claude?.args).not.toContain("acceptEdits");
    const gemini = ADAPTERS.gemini.invokeModelProbe?.("model-x", dir);
    expect(gemini?.args).toContain("--policy");
    expect(gemini?.args).not.toContain("yolo");
    expect(readFileSync(gemini!.args.at(-1)!, "utf8")).toContain("priority = 999");
    const codex = ADAPTERS.codex.invokeModelProbe?.("model-x", dir);
    expect(codex?.args).toContain("read-only");
    expect(codex?.args).toContain("approval_policy=\"never\"");
    expect(codex?.args).toContain("--ignore-user-config");
    expect(codex?.args).toContain("shell_tool");
    expect(codex?.args).toContain("hooks");
    expect(codex?.args).toContain("model-x");
    expect(codex?.input).toBe("只回答 OK，不要呼叫任何工具。");
    expect(readFileSync(join(dir, ".gemini", "settings.json"), "utf8")).toContain('"enabled":false');
    rmSync(dir, { recursive: true, force: true });
  });

  it("command 只接受與輸入名稱一致的結構化回報", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-probe-"));
    const script = join(dir, "probe.cjs");
    writeFileSync(script, "console.log(JSON.stringify({requestedModel:process.argv[2],resolvedModel:'actual-id'}))");
    const def = { adapter: "command" as const, extraArgs: [], command: ["custom", "--model", "{model}"], modelProbe: [process.execPath, script, "{model}"] };
    expect(await probeModel(def, "alias", 1000)).toMatchObject({ status: "ok", resolvedModel: "actual-id" });
    writeFileSync(script, "console.log(JSON.stringify({requestedModel:'other',resolvedModel:'actual-id'}))");
    expect((await probeModel(def, "alias", 1000)).status).toBe("failed");
  });

  it("command 探測逾時拒絕驗證", async () => {
    const command = { adapter: "command" as const, extraArgs: [], command: ["custom", "{model}"], modelProbe: [process.execPath, "-e", "setTimeout(()=>{},10000)", "{model}"] };
    expect((await probeModel(command, "alias", 30)).status).toBe("failed");
  });

  it.each(["codex", "gemini"] as const)("%s 短請求需有文字與成功完成，工具或錯誤不能通過", async (adapter) => {
    const bin = mkdtempSync(join(tmpdir(), "agentflowctl-probe-bin-"));
    const fake = join(bin, adapter);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    const text = adapter === "codex"
      ? { type: "item.completed", item: { type: "agent_message", text: "OK" } }
      : { type: "message", role: "assistant", content: "OK" };
    const done = adapter === "codex" ? { type: "turn.completed", usage: {} } : { type: "result", status: "success" };
    const tool = adapter === "codex"
      ? { type: "item.completed", item: { type: "mcp_tool_call", server: "test", tool: "read", status: "completed" } }
      : { type: "tool_use", tool_name: "read_file" };
    const error = adapter === "codex" ? { type: "turn.failed", error: { message: "invalid model" } } : { type: "result", status: "error" };
    const emit = (events: unknown[], code = 0) => writeFileSync(fake,
      `#!/bin/sh\n${events.map((event) => `echo '${JSON.stringify(event)}'`).join("\n")}\nexit ${code}\n`, { mode: 0o755 });
    try {
      const def = { adapter, extraArgs: ["--yolo"] };
      emit([text, done]);
      expect((await probeModel(def, "model-x", 5000)).status).toBe("ok");
      for (const events of [[text], [done], [text, error], [text, tool, done], [error, text, done]]) {
        emit(events);
        expect((await probeModel(def, "model-x", 5000)).status).toBe("failed");
      }
      emit([text, done], 1);
      expect((await probeModel(def, "model-x", 5000)).status).toBe("failed");
      writeFileSync(fake, '#!/bin/sh\necho "unknown option" >&2\nexit 2\n', { mode: 0o755 });
      expect(await probeModel(def, "model-x", 5000)).toMatchObject({ status: "failed", reason: expect.stringContaining("請更新 CLI") });
      const diagnostics = adapter === "gemini"
        ? ["Ignoring --admin-policy", "[ADMIN] Policy file error in deny-tools.toml:"]
        : ["ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox"];
      for (const warning of diagnostics) {
        writeFileSync(fake, `#!/bin/sh\necho '${warning}' >&2\necho '${JSON.stringify(text)}'\necho '${JSON.stringify(done)}'\n`, { mode: 0o755 });
        expect((await probeModel(def, "model-x", 5000)).status).toBe("failed");
      }
      if (adapter === "codex") {
        emit([text, { type: "item.started", item: { type: "command_execution", command: "echo test" } }, done]);
        expect((await probeModel(def, "model-x", 5000)).status).toBe("failed");
      }
    } finally {
      process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("會發 done 事件的 CLI 沒回報完成時不算通過", async () => {
    const bin = mkdtempSync(join(tmpdir(), "agentflowctl-probe-bin-"));
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
    const result = JSON.stringify({ type: "result", is_error: false, result: "OK" });
    const fake = join(bin, "claude");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      writeFileSync(fake, `#!/bin/sh\necho '${text}'\n`, { mode: 0o755 });
      expect(await probeModel({ adapter: "claude", extraArgs: [] }, "model-x", 5000)).toMatchObject({ status: "failed" });
      writeFileSync(fake, `#!/bin/sh\necho '${text}'\necho '${result}'\n`, { mode: 0o755 });
      expect((await probeModel({ adapter: "claude", extraArgs: [] }, "model-x", 5000)).status).toBe("ok");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("把常見失敗歸類成使用者看得懂的原因", () => {
    expect(probeFailureReason("HTTP 429 quota exceeded")).toContain("額度");
    expect(probeFailureReason("invalid model id")).toContain("模型名稱");
    expect(probeFailureReason("authentication failed")).toContain("認證");
  });
});
