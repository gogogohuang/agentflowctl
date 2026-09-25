import { describe, expect, it } from "vitest";
import { exec } from "./proc.js";
import { isQuotaError } from "./runner.js";

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

describe("移除環境變數", () => {
  it("unsetEnv 會讓子程序看不到指定的變數", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const r = await exec("node", ["-e", "console.log(process.env.ANTHROPIC_API_KEY ?? 'none')"], { unsetEnv: ["ANTHROPIC_API_KEY"] });
    expect(r.stdout.trim()).toBe("none");
    delete process.env.ANTHROPIC_API_KEY;
  });
});
