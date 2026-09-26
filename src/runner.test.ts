import { describe, expect, it } from "vitest";
import { formatToolLine, isQuotaError, parseResultMeta, resolveAgent } from "./runner.js";
import { RepoConfig } from "./schemas.js";

describe("回覆的 XML 中繼資料", () => {
  it("解析 <result> 區塊", () => {
    const text = `完成了。
<result>
  <status>done</status>
  <summary>新增 zod 驗證</summary>
  <files_changed>
    <file>src/form.ts</file>
    <file> src/schema.ts </file>
  </files_changed>
  <concerns>AC-2 的測試斷言過於寬鬆</concerns>
</result>`;
    expect(parseResultMeta(text)).toEqual({
      status: "done",
      summary: "新增 zod 驗證",
      filesChanged: ["src/form.ts", "src/schema.ts"],
      concerns: "AC-2 的測試斷言過於寬鬆",
    });
  });

  it("沒有 <result> 或 status 不合法時回傳 undefined", () => {
    expect(parseResultMeta("只有純文字")).toBeUndefined();
    expect(parseResultMeta("<result><status>maybe</status><summary>x</summary></result>")).toBeUndefined();
  });

  it("有多個區塊時取最後一個，缺少的欄位給預設值", () => {
    const text =
      "範例：<result><status>blocked</status><summary>舊的</summary></result>\n" +
      "<result><status>done</status><summary>新的</summary><files_changed></files_changed></result>";
    expect(parseResultMeta(text)).toEqual({ status: "done", summary: "新的", filesChanged: [], concerns: "" });
  });
});

describe("額度錯誤偵測", () => {
  it("辨識常見的額度與速率限制訊息", () => {
    expect(isQuotaError("Claude AI usage limit reached|1760000000")).toBe(true);
    expect(isQuotaError("You've hit your usage limit. Try again later.")).toBe(true);
    expect(isQuotaError("429 RESOURCE_EXHAUSTED: Quota exceeded")).toBe(true);
    expect(isQuotaError("Error: Too Many Requests")).toBe(true);
  });

  it("一般的失敗不算額度用完", () => {
    expect(isQuotaError("TypeError: cannot read properties of undefined")).toBe(false);
    expect(isQuotaError("tests failed: 3 assertions")).toBe(false);
  });
});

describe("工具事件的畫面輸出", () => {
  it("完整顯示指令，不截斷", () => {
    const cmd = `pnpm vitest run ${"z".repeat(200)}`;
    expect(formatToolLine("codex", { name: "shell", detail: cmd })).toBe(`    🔧 [codex] shell: ${cmd}`);
  });

  it("多行指令逐行縮排對齊", () => {
    expect(formatToolLine("claude", { name: "Bash", detail: "cat <<EOF\nhi\nEOF" }))
      .toBe("    🔧 [claude] Bash: cat <<EOF\n       hi\n       EOF");
  });

  it("沒有細節時只顯示工具名稱", () => {
    expect(formatToolLine("gemini", { name: "write_file" })).toBe("    🔧 [gemini] write_file");
  });
});

describe("resolveAgent", () => {
  it("沒有內建 agent，只認 agents 裡定義的", () => {
    expect(() => resolveAgent(RepoConfig.parse({}), "gemini")).toThrow(/未定義/);
    expect(resolveAgent(RepoConfig.parse({ agents: { g: { adapter: "gemini" } } }), "g").adapter).toBe("gemini");
  });

  it("依 adapter 套用全域預設 model，個別設定優先", () => {
    const cfg = RepoConfig.parse({
      defaultModels: { claude: "opus", codex: "gpt-5", gemini: "gemini-pro" },
      agents: {
        c: { adapter: "claude" },
        x: { adapter: "codex", model: "gpt-5-mini" },
        g: { adapter: "gemini" },
        custom: { adapter: "command", command: ["my-agent"] },
      },
    });
    expect(resolveAgent(cfg, "c").model).toBe("opus");
    expect(resolveAgent(cfg, "x").model).toBe("gpt-5-mini");
    expect(resolveAgent(cfg, "g").model).toBe("gemini-pro");
    expect(resolveAgent(cfg, "custom").model).toBeUndefined();
    expect(cfg.agents.c?.model).toBeUndefined();
  });

  it("沒有全域預設時沿用 CLI 預設，空白 model 設定不合法", () => {
    expect(resolveAgent(RepoConfig.parse({ agents: { c: { adapter: "claude" } } }), "c").model).toBeUndefined();
    expect(() => RepoConfig.parse({ defaultModels: { codex: "  " } })).toThrow();
    expect(() => RepoConfig.parse({ defaultModels: { unknown: "model" } })).toThrow();
  });
});
