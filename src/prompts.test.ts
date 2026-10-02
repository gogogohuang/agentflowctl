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
  roleGoal: "你的測試要精準描述任務要新增的行為，並且在功能實作前確實失敗。",
  redGuidance: "3. 測試必須因為功能尚未實作而失敗。",
  verifyNote: "驗證測試是否失敗",
  step: "T-1-fix",
  error: "handoff-response.json 不存在",
  range: "abc1234..def5678",
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

  it("規格、計畫審查、分層審查、修訂與仲裁共用同一套驗收條件標準", () => {
    const text = (name: string) => renderPrompt(name, vars);
    for (const name of ["plan-review", "plan-review-index"]) {
      const t = text(name);
      expect(t).toContain("一項非行為變更的完成結果");
      expect(t).toContain("必須新寫或修改程式才會有的結果");
      expect(t).toContain("需求明寫「維持不變」的行為");
    }
    expect(text("spec")).toContain("一項非行為變更的完成結果");
    expect(text("spec")).toContain("需求明寫要維持不變的行為");
    expect(text("plan-fix")).toContain("一項非行為變更的完成結果");
    expect(text("plan-fix")).toContain("併入相關條件或刪除");
    expect(text("plan-arbiter")).toContain("不需另寫程式就必然成立的推論");
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
    // 描述點名的路徑可能是這個計畫才要新建的檔案，不能說成「既有檔案」
    expect(group).not.toContain("既有檔案");
    expect(group).toContain("可能尚未存在，不存在就不用讀");
    expect(group).not.toContain("{{");
    const plan = renderPrompt("plan", vars);
    expect(plan).toContain("## T-1");
    expect(plan).toContain("含目錄的路徑");
  });

  it("計畫修訂把審查回應覆寫到獨立檔，並保留整體做法與任務標題", () => {
    const fix = renderPrompt("plan-fix", vars);
    expect(fix).toContain(".flow/plan-replies.md");
    expect(fix).toContain("## T-1");
    expect(fix).toContain("覆寫");
    expect(fix).toContain("所有任務群都要重審");
    expect(fix).not.toContain("## 審查回應");
    const arbiter = renderPrompt("plan-arbiter", vars);
    expect(arbiter).toContain(".flow/plan-replies.md");
    expect(arbiter).not.toContain("plan.md 最後有作者對審查意見的回應");
    expect(arbiter).toContain("`status` 只能是以下三個值之一");
    expect(arbiter).toContain(".flow/feedback.md");
    expect(renderPrompt("plan-review", vars)).toContain(".flow/plan-replies.md");
  });

  it.each(["implement-code", "implement-tests"])("%s 要求沒修改時不重跑同一個指令，修改後仍可重跑", (name) => {
    const text = renderPrompt(name, vars);
    expect(text).toContain("沒有修改任何檔案時，不要重跑同一個指令");
    expect(text).toContain("修改後可以再跑一次確認");
  });
});
