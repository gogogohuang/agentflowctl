import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPrompt } from "./util.js";

const names = readdirSync(new URL("../prompts/", import.meta.url))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3));

// 所有 prompt 會用到的變數，給假值就能完整渲染
const vars = {
  requirement: "需求",
  reviewer: "codex",
  author: "claude",
  authors: "claude",
  task: "{}",
  testPattern: "\\.test\\.ts$",
  testCmd: "npx vitest run",
  redOutput: "FAIL",
};

describe("prompts", () => {
  it.each(names)("%s 有專屬角色並要求 XML 中繼資料", (name) => {
    const text = renderPrompt(name, vars);
    expect(text).toMatch(/^<role>\n你是[\s\S]+?<\/role>/);
    expect(text).toContain("<reply_format>");
    expect(text).toContain("<result>");
  });

  it("每份 prompt 的角色都不一樣", () => {
    const roles = names.map((n) => renderPrompt(n, vars).match(/<role>\n你是([^，（]+)/)?.[1]);
    expect(new Set(roles).size).toBe(names.length);
  });
});
