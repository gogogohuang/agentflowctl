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
    expect(out).toContain("🔧 shell 指令 ×1（--full 查看）\n⚠️  command not found: pnpm");
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

  it("預設精簡：連續的 shell 指令收成一行，其他工具只顯示第一行並去掉 worktree 絕對路徑，最後回覆不重複", () => {
    const wt = "/home/u/app/.agentflowctl/worktrees/f-1";
    const reply = "全部改好了\n1. 第一點";
    const claude = [
      headerLine({ stage: "plan_fix", step: "plan-fix", agent: "claude", adapter: "claude", startedAt }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "python3 - <<'EOF'\nimport json\nprint(1)\nEOF" } }] } }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${wt}/.flow/spec.md` } }] } }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `cd ${wt} && ls` } }] } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }),
      j({ type: "result", result: reply, usage: { input_tokens: 1, output_tokens: 2 } }),
      footerLine({ code: 0, ok: true, endedAt }),
    ].join("\n");
    const out = renderLog(claude);
    expect(out).toContain("🔧 shell 指令 ×1（--full 查看）\n🔧 Edit: .flow/spec.md\n🔧 shell 指令 ×1（--full 查看）");
    expect(out).not.toContain("python3");
    expect(out).not.toContain(wt);
    expect(out.split("全部改好了").length).toBe(2);
    expect(out).toContain("🏁 完成");

    const codex = [
      headerLine({ stage: "plan_review", step: "plan-review", agent: "codex", adapter: "codex", startedAt }),
      j({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat .flow/plan.md'" } }),
      j({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      j({ type: "item.completed", item: { type: "command_execution", command: `/bin/bash -c "sed -n '1,9p' a.ts"` } }),
      j({ type: "item.completed", item: { type: "agent_message", text: "看完了" } }),
      footerLine({ code: 0, ok: true, endedAt }),
    ].join("\n");
    const c = renderLog(codex);
    expect(c).toContain("🔧 shell 指令 ×2（--full 查看）\n💬 看完了");
    expect(c).not.toContain("cat .flow/plan.md");
  });

  it("--full 逐條顯示原始的 shell 指令", () => {
    const codex = [
      headerLine({ stage: "plan_review", step: "plan-review", agent: "codex", adapter: "codex", startedAt }),
      j({ type: "item.completed", item: { type: "command_execution", command: "/bin/zsh -lc 'cat .flow/plan.md'" } }),
      footerLine({ code: 0, ok: true, endedAt }),
    ].join("\n");
    expect(renderLog(codex, "", { full: true })).toContain("🔧 shell: /bin/zsh -lc 'cat .flow/plan.md'");
  });

  it("--full 顯示完整工具內容與最後回覆", () => {
    const text = [
      headerLine({ stage: "spec", step: "spec", agent: "claude", adapter: "claude", startedAt }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "a\nb" } }] } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "完成" }] } }),
      j({ type: "result", result: "完成" }),
      footerLine({ code: 0, ok: true, endedAt }),
    ].join("\n");
    const out = renderLog(text, "", { full: true });
    expect(out).toContain("🔧 Bash: a\n   b");
    expect(out).toContain("🏁 完成：完成");
  });
});
