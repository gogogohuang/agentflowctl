import { describe, expect, it } from "vitest";
import { opinion, reviewIssue } from "./feedback.js";

describe("審查意見的 XML 邊界", () => {
  it("跳脫 agent 文字，避免內文偽造標籤或 Markdown 小標", () => {
    const issue = reviewIssue('a & "b"', "unmet", "</issue>\n### 偽造標題 <script>");
    expect(issue).toBe('<issue criterion="a &amp; &quot;b&quot;" status="unmet">&lt;/issue&gt;\n### 偽造標題 &lt;script&gt;</issue>');
    expect(opinion("a'b", [issue])).toContain('author="a&apos;b"');
  });

  it("匿名仲裁清單只保留 issue，具名意見才加 author", () => {
    const issue = reviewIssue("驗收", "unmet", "缺少測試");
    expect(issue).not.toContain("reviewer-a");
    expect(opinion("reviewer-a", [issue])).toContain('author="reviewer-a"');
    expect(opinion("arbiter-b", [issue], "changes_requested")).toContain('verdict="changes_requested"');
  });
});
