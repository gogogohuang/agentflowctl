import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { footerLine, headerLine, listLogs, logMark, nextLogFile, renderLog } from "./logs.js";

const j = (o: unknown) => JSON.stringify(o);
const startedAt = "2026-09-26T03:00:00.000Z";
const endedAt = "2026-09-26T03:01:00.000Z";

describe("log 檔名", () => {
  it("序號-階段-步驟-agent，序號接在目錄裡最大的之後", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-logs-"));
    const first = nextLogFile(dir, "implement", "T1-tests", "claude");
    expect(basename(first)).toBe("001-implement-T1-tests-claude.log");
    writeFileSync(first, "");
    writeFileSync(join(dir, "009-verify-lint-cmd.log"), "");
    expect(basename(nextLogFile(dir, "verify", "type check", "cmd"))).toBe("010-verify-type_check-cmd.log");
  });

  it("不存在的目錄從 001 開始", () => {
    expect(basename(nextLogFile("/nonexistent/agentflowctl", "spec", "spec", "codex"))).toBe("001-spec-spec-codex.log");
  });
});

describe("log 列表", () => {
  it("依序號排序，讀出檔頭與成功／失敗／未結束", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-logs-"));
    writeFileSync(join(dir, "002-verify-lint-cmd.log"),
      [headerLine({ stage: "verify", step: "lint", agent: "cmd", startedAt }), "$ pnpm lint", footerLine({ code: 1, ok: false, endedAt })].join("\n"));
    writeFileSync(join(dir, "001-spec-spec-claude.log"),
      [headerLine({ stage: "spec", step: "spec", agent: "claude", adapter: "claude", startedAt }), footerLine({ code: 0, ok: true, endedAt })].join("\n"));
    writeFileSync(join(dir, "003-review-review-codex.log"), headerLine({ stage: "review", step: "review", agent: "codex", adapter: "codex", startedAt }));
    writeFileSync(join(dir, "notes.txt"), "");
    const logs = listLogs(dir);
    expect(logs.map((e) => [e.seq, e.header?.step, logMark(e)])).toEqual([[1, "spec", "✓"], [2, "lint", "✗"], [3, "review", "…"]]);
  });
});

describe("log 解析", () => {
  it("claude 失敗：列出事件，錯誤整理附上結束碼、錯誤事件與 stderr", () => {
    const text = [
      headerLine({ stage: "implement", step: "T1-code", agent: "claude", adapter: "claude", startedAt }),
      j({ type: "system", subtype: "init", session_id: "s" }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "先跑測試" }, { type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] } }),
      j({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "command not found: pnpm" }] } }),
      j({ type: "result", is_error: true, result: "API Error: 500 overloaded", usage: { input_tokens: 10, output_tokens: 2 } }),
      "[stderr]",
      "Error: something broke",
      footerLine({ code: 1, ok: false, endedAt }),
    ].join("\n");
    const out = renderLog(text, "/logs/007-implement-T1-code-claude.log");
    expect(out).toContain("#7  implement / T1-code / claude");
    expect(out).toContain("結束碼 1　✗ 失敗");
    expect(out).toContain("💬 先跑測試");
    expect(out).toContain("🔧 Bash: pnpm test");
    expect(out).toContain("⚠️  command not found: pnpm");
    expect(out).toContain("🏁 失敗：API Error: 500 overloaded");
    expect(out).toContain("（另有 1 行其他事件未顯示");
    const errors = out.slice(out.indexOf("── 錯誤 ──"));
    expect(errors).toContain("結束碼 1");
    expect(errors).toContain("agent 回報失敗：API Error: 500 overloaded");
    expect(errors).toContain("Error: something broke");
    expect(errors).not.toContain("command not found");
  });

  it("adapter 不認得的頂層錯誤事件與非 JSON 行也會顯示", () => {
    const text = [
      headerLine({ stage: "spec", step: "spec", agent: "g", adapter: "gemini", startedAt }),
      j({ type: "fatal_error", error: { message: "auth expired" } }),
      "Loaded cached credentials.",
      footerLine({ code: 41, ok: false, endedAt }),
    ].join("\n");
    const out = renderLog(text);
    expect(out).toContain("spec / spec / g（adapter gemini）");
    expect(out).toContain("❌ auth expired");
    expect(out).toContain("📄 Loaded cached credentials.");
    expect(out).toContain("錯誤事件：auth expired");
  });

  it("專案指令的 log 原樣顯示輸出", () => {
    const text = [headerLine({ stage: "verify", step: "lint", agent: "cmd", startedAt }), "$ pnpm lint", "a.ts:1 error", footerLine({ code: 2, ok: false, endedAt })].join("\n");
    const out = renderLog(text);
    expect(out).toContain("$ pnpm lint\na.ts:1 error");
    expect(out).toContain("── 錯誤 ──\n結束碼 2");
  });

  it("成功時沒有錯誤段落，stderr 歸在其他輸出；沒有檔尾時標示未結束", () => {
    const ok = [headerLine({ stage: "spec", step: "spec", agent: "codex", adapter: "codex", startedAt }), "[stderr]", "warning: x", footerLine({ code: 0, ok: true, endedAt })].join("\n");
    expect(renderLog(ok)).not.toContain("── 錯誤 ──");
    expect(renderLog(ok)).toContain("── 其他輸出 ──");
    expect(renderLog(headerLine({ stage: "spec", step: "spec", agent: "codex", adapter: "codex", startedAt }))).toContain("沒有結束紀錄");
  });
});
