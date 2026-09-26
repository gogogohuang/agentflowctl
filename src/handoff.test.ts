import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-handoff-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);
const { handoffPath } = await import("./paths.js");
const { readHandoff, previewHandoff, mergeHandoff, openActions } = await import("./handoff.js");

const source = { stage: "implement" as const, step: "T-1-code", agent: "codex", callKey: "f-a:implement:T-1:code:0:codex" };
const issue = { kind: "action" as const, summary: "測試未涵蓋逾時", evidence: "src/api.test.ts:20", targetStage: "code" as const };
const empty = { newIssues: [], dispositions: [] };

describe("交接紀錄", () => {
  it("舊 run 沒有紀錄時視為空，空回覆也能明確記下已交接", () => {
    expect(readHandoff("f-a")).toEqual({ version: 1, issues: [] });
    expect(mergeHandoff("f-a", source.callKey, source, empty, "writer").issues).toEqual([]);
  });

  it("依呼叫識別碼產生穩定 ID，重播不重複，另一輪仍會新增", () => {
    const response = { newIssues: [issue], dispositions: [] };
    const first = mergeHandoff("f-b", source.callKey, source, response, "writer");
    const again = mergeHandoff("f-b", source.callKey, source, response, "writer");
    expect(again).toEqual(first);
    expect(first.issues).toHaveLength(1);
    expect(first.issues[0]?.id).toBeTruthy();
    expect(openActions(first, "code")).toHaveLength(1);
    const nextKey = `${source.callKey}:round2`;
    const next = mergeHandoff("f-b", nextKey, { ...source, callKey: nextKey }, response, "writer");
    expect(next.issues).toHaveLength(2);
  });

  it("作者只可提議已修正，由審查者附證據結案", () => {
    const created = mergeHandoff("f-c", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const id = created.issues[0]!.id;
    const proposal = { newIssues: [], dispositions: [{ id, status: "proposed_resolved" as const, reason: "補了逾時斷言", evidence: "abc123" }] };
    const proposed = previewHandoff(created, "proposal", { ...source, callKey: "proposal" }, proposal, "writer");
    expect(proposed.issues[0]?.status).toBe("proposed_resolved");
    expect(openActions(proposed, "code")).toHaveLength(1);
    const reviewer = { stage: "review" as const, step: "review", agent: "claude", callKey: "review-1" };
    const settled = previewHandoff(proposed, "review-1", reviewer, {
      newIssues: [], dispositions: [{ id, status: "resolved" as const, reason: "斷言已覆蓋逾時", evidence: "src/api.test.ts:25" }],
    }, "reviewer");
    expect(openActions(settled, "code")).toEqual([]);
    expect(() => previewHandoff(created, "bad-writer", { ...source, callKey: "bad-writer" }, {
      newIssues: [], dispositions: [{ id, status: "resolved", reason: "自己核准", evidence: "abc" }],
    }, "writer")).toThrow();
  });

  it("不存在的 ID 與缺少理由的結案不會覆寫正式紀錄", () => {
    const created = mergeHandoff("f-d", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    expect(() => mergeHandoff("f-d", "bad", { ...source, callKey: "bad" }, {
      newIssues: [], dispositions: [{ id: "missing", status: "accepted", reason: "無須修改", evidence: "檢查結果" }],
    }, "reviewer")).toThrow();
    expect(readHandoff("f-d")).toEqual(created);
    expect(() => previewHandoff(created, "bad2", { ...source, callKey: "bad2" }, {
      newIssues: [], dispositions: [{ id: created.issues[0]!.id, status: "accepted", reason: "", evidence: "" }],
    }, "reviewer")).toThrow();
  });

  it("格式錯誤的既有正式紀錄不會被當成空紀錄", () => {
    const path = handoffPath("f-e");
    execFileSync("mkdir", ["-p", join(root, ".agentflowctl", "runs", "f-e")]);
    writeFileSync(path, "{broken");
    expect(() => readHandoff("f-e")).toThrow();
  });
});
