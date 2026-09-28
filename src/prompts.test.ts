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
  acceptance: "[]",
  testPattern: "\\.test\\.ts$",
  testCmd: "npx vitest run",
  redOutput: "FAIL",
  index: "- T-1 標題 | AC-1 | depends：（無）\n  改 src/form.ts",
  overview: "# 計畫\n整體做法",
  groupId: "G-1",
  files: "src/form.ts",
  tasks: "[]",
  neighbors: "（沒有跨群的直接相依）",
  evidence: "",
  replies: "",
};

describe("prompts", () => {
  it.each(names)("%s 有專屬角色並要求 XML 中繼資料", (name) => {
    const text = renderPrompt(name, vars);
    expect(text).toMatch(/^<role>\n你是[\s\S]+?<\/role>/);
    expect(text).toContain("<reply_format>");
    expect(text).toContain("<result>");
    expect(text).toContain(".flow/handoff-context.md");
    expect(text).toContain(".flow/handoff-response.json");
    expect(text).toContain('"newIssues": []');
    expect(text).toContain('"dispositions": []');
  });

  it("每份 prompt 的角色都不一樣", () => {
    const roles = names.map((n) => renderPrompt(n, vars).match(/<role>\n你是([^，（]+)/)?.[1]);
    expect(new Set(roles).size).toBe(names.length);
  });

  it("索引審查讀規格與全部任務描述，群審查帶相鄰任務但不讀規格，計畫要求任務標題與路徑", () => {
    const index = renderPrompt("plan-review-index", vars);
    expect(index).toContain("計畫索引審查者");
    expect(index).toContain(vars.index);
    expect(index).toContain(vars.overview);
    expect(index).toContain("<acceptance>");
    expect(index).toContain("<replies>");
    expect(index).toContain(".flow/spec.md");
    expect(index).toContain("跨任務一致性");
    expect(index).toContain("evidence 點名的檔案");
    expect(index).not.toContain(".flow/tasks.json");
    const group = renderPrompt("plan-review-group", vars);
    expect(group).toContain("計畫群審查者");
    expect(group).toContain("G-1");
    expect(group).toContain("<neighbors>");
    expect(group).toContain(".flow/plan-review-group.json");
    expect(group).not.toContain(".flow/spec.md");
    expect(group).not.toContain("{{");
    const plan = renderPrompt("plan", vars);
    expect(plan).toContain("## T-1");
    expect(plan).toContain("含目錄的路徑");
  });
});
