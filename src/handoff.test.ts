import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-handoff-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);
const { flowDir, handoffPath } = await import("./paths.js");
const { readHandoff, previewHandoff, mergeHandoff, openActions, prepareHandoff, validateHandoffResponse, acceptHandoff, recoverHandoff, reviewHandoffGate, isDuplicateIssue } = await import("./handoff.js");

const source = { stage: "implement" as const, step: "T-1-code", agent: "codex", callKey: "f-a:implement:T-1:code:0:codex" };
const issue = { kind: "action" as const, summary: "測試未涵蓋逾時", evidence: "src/api.test.ts:20", targetStage: "code" as const };
const empty = { newIssues: [], dispositions: [] };

describe("交接紀錄", () => {
  it("舊 run 沒有紀錄時視為空，空回覆也能明確記下已交接", () => {
    expect(readHandoff("f-a")).toEqual({ version: 1, issues: [] });
    expect(mergeHandoff("f-a", source.callKey, source, empty, "writer").issues).toEqual([]);
  });

  it("依呼叫識別碼產生穩定 ID，重播不重複，另一輪的不同事項仍會新增", () => {
    const response = { newIssues: [issue], dispositions: [] };
    const first = mergeHandoff("f-b", source.callKey, source, response, "writer");
    const again = mergeHandoff("f-b", source.callKey, source, response, "writer");
    expect(again).toEqual(first);
    expect(first.issues).toHaveLength(1);
    expect(first.issues[0]?.id).toBeTruthy();
    expect(openActions(first, "code")).toHaveLength(1);
    const nextKey = `${source.callKey}:round2`;
    const other = { ...issue, summary: "沒有處理空陣列", evidence: "src/list.ts:8" };
    const next = mergeHandoff("f-b", nextKey, { ...source, callKey: nextKey }, { newIssues: [other], dispositions: [] }, "writer");
    expect(next.issues).toHaveLength(2);
  });

  it("不同輪重複回報同一件事時併進原事項並累計次數", () => {
    const first = mergeHandoff("f-dup", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const key2 = `${source.callKey}:round2`;
    const next = mergeHandoff("f-dup", key2, { ...source, callKey: key2 }, { newIssues: [issue], dispositions: [] }, "writer");
    expect(next.issues).toHaveLength(1);
    expect(next.issues[0]).toMatchObject({ id: first.issues[0]!.id, repeats: 1, status: "open" });
    expect(next.issues[0]?.source.callKey).toBe(source.callKey);
  });

  it("措辭不同但指向同一檔案與條件的事項視為重複，同檔案的不同問題則不併", () => {
    const a = { kind: "action" as const, targetStage: "plan" as const,
      summary: "AC-8 要求移除 getContentWrapContainer.ts 及其測試，與本階段禁止刪除任何 test/spec 檔案的限制衝突。",
      evidence: "src/pages/driver_mileage/utils/getContentWrapContainer.ts 與 getContentWrapContainer.test.ts 仍存在；直接刪除後者違反本階段 constraints。" };
    const b = { ...a,
      summary: "AC-8 要求移除 getContentWrapContainer.ts 及其測試，但本階段硬性限制禁止刪除測試檔，兩者互相衝突。",
      evidence: ".flow/acceptance.json AC-8；現有 src/pages/driver_mileage/utils/getContentWrapContainer.test.ts 受『不可刪除測試檔』限制。" };
    expect(isDuplicateIssue(a, b)).toBe(true);
    const sameFileOtherProblem = { ...a, summary: "getContentWrapContainer.ts 在 SSR 時 document 未定義會丟錯", evidence: "src/pages/driver_mileage/utils/getContentWrapContainer.ts:5" };
    expect(isDuplicateIssue(a, sameFileOtherProblem)).toBe(false);
  });

  it("種類不同、已提議修正或已結案的事項不被併入", () => {
    const info = { ...issue, kind: "info" as const };
    expect(isDuplicateIssue(issue, info)).toBe(false);
    const created = mergeHandoff("f-st", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const id = created.issues[0]!.id;
    const key2 = `${source.callKey}:r2`;
    const proposed = mergeHandoff("f-st", key2, { ...source, callKey: key2 },
      { newIssues: [], dispositions: [{ id, status: "proposed_resolved", reason: "補了", evidence: "abc" }] }, "writer");
    const key3 = `${source.callKey}:r3`;
    const again = mergeHandoff("f-st", key3, { ...source, callKey: key3 }, { newIssues: [issue], dispositions: [] }, "reviewer");
    expect(proposed.issues[0]?.status).toBe("proposed_resolved");
    expect(again.issues).toHaveLength(2);
  });

  it("同一個回覆內重複的事項也只留一筆", () => {
    const next = mergeHandoff("f-same", source.callKey, source, { newIssues: [issue, issue], dispositions: [] }, "writer");
    expect(next.issues).toHaveLength(1);
    expect(next.issues[0]?.repeats).toBe(1);
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

  it("下一位只看相關未結事項，匿名仲裁不會看到來源身分", () => {
    mergeHandoff("f-f", source.callKey, source, { newIssues: [issue, { ...issue, targetStage: "plan" }], dispositions: [] }, "writer");
    prepareHandoff("f-f", "next", "code", false);
    const context = readFileSync(join(flowDir("f-f"), "handoff-context.md"), "utf8");
    expect(context).toContain("測試未涵蓋逾時");
    expect(context.match(/測試未涵蓋逾時/g)).toHaveLength(1);
    expect(context).toContain("codex");
    prepareHandoff("f-f", "arbiter", "plan", true);
    const blind = readFileSync(join(flowDir("f-f"), "handoff-context.md"), "utf8");
    expect(blind).not.toContain("codex");
    expect(blind).toContain("測試未涵蓋逾時");
  });

  it("參考資訊會交給目標階段，但不會阻擋審查核准", () => {
    mergeHandoff("f-info", source.callKey, source, {
      newIssues: [{ kind: "info", summary: "沿用既有重試策略", evidence: "src/retry.ts:1", targetStage: "code" }], dispositions: [],
    }, "writer");
    prepareHandoff("f-info", "next", "code", false);
    expect(readFileSync(join(flowDir("f-info"), "handoff-context.md"), "utf8")).toContain("沿用既有重試策略");
    expect(reviewHandoffGate(readHandoff("f-info"), "code", "approve")).toBeUndefined();
  });

  it("交接脈絡標出事項類型；審查者誤把參考資訊寫進 dispositions 時略過，不讓審查重試", () => {
    const created = mergeHandoff("f-info-dispose", source.callKey, source, {
      newIssues: [{ kind: "info", summary: "routes.test.tsx 不存在", evidence: "src/containers/", targetStage: "plan" }], dispositions: [],
    }, "writer");
    const infoId = created.issues[0]!.id;
    prepareHandoff("f-info-dispose", "next", "plan", false);
    const context = readFileSync(join(flowDir("f-info-dispose"), "handoff-context.md"), "utf8");
    expect(context).toContain("## 參考資訊（info，只供參考，不要放進 dispositions）");
    expect(context).toContain("類型：info");
    const reviewer = { ...source, stage: "plan_review" as const, step: "plan-review", agent: "claude", callKey: "f-info-dispose:review" };
    const next = mergeHandoff("f-info-dispose", reviewer.callKey, reviewer, {
      newIssues: [], dispositions: [{ id: infoId, status: "resolved", reason: "已改測 PageVersionSwitch", evidence: ".flow/tasks.json T-1" }],
    }, "reviewer");
    expect(next.issues[0]).toMatchObject({ kind: "info", status: "open" });
    expect(next.appliedCalls).toContain(reviewer.callKey);
  });

  it("待審核的修正理由與證據會交給審查者", () => {
    const created = mergeHandoff("f-proposal", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const id = created.issues[0]!.id;
    const proposalSource = { ...source, callKey: "f-proposal:fix" };
    mergeHandoff("f-proposal", proposalSource.callKey, proposalSource, {
      newIssues: [], dispositions: [{ id, status: "proposed_resolved", reason: "補了逾時斷言", evidence: "commit abc123" }],
    }, "writer");
    prepareHandoff("f-proposal", "review", "code", false);
    const context = readFileSync(join(flowDir("f-proposal"), "handoff-context.md"), "utf8");
    expect(context).toContain("補了逾時斷言");
    expect(context).toContain("commit abc123");
  });

  it("缺失或無效的回覆不視為空清單", () => {
    prepareHandoff("f-g", "step", "code", false);
    expect(validateHandoffResponse("f-g").ok).toBe(false);
    writeFileSync(join(flowDir("f-g"), "handoff-response.json"), "{}");
    expect(validateHandoffResponse("f-g").ok).toBe(false);
    writeFileSync(join(flowDir("f-g"), "handoff-response.json"), JSON.stringify(empty));
    expect(validateHandoffResponse("f-g")).toEqual({ ok: true, data: empty });
  });

  it("接受已驗證回覆後可重播，同一步驟開始時清掉舊回覆", () => {
    prepareHandoff("f-h", source.callKey, "code", false);
    const path = join(flowDir("f-h"), "handoff-response.json");
    writeFileSync(path, JSON.stringify({ newIssues: [issue], dispositions: [] }));
    const parsed = validateHandoffResponse("f-h");
    if (!parsed.ok) throw new Error(parsed.error);
    acceptHandoff("f-h", source.callKey, source, parsed.data, "writer");
    recoverHandoff("f-h");
    expect(readHandoff("f-h").issues).toHaveLength(1);
    prepareHandoff("f-h", "next", "code", false);
    expect(existsSync(path)).toBe(false);
  });

  it("中斷留下的已驗證收據可恢復，而且重播不重複", () => {
    const id = "f-receipt";
    const dir = join(root, ".agentflowctl", "runs", id, "handoff-receipts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${createHash("sha256").update(source.callKey).digest("hex").slice(0, 16)}.json`);
    writeFileSync(path, JSON.stringify({ callKey: source.callKey, source, response: { newIssues: [issue], dispositions: [] }, role: "writer" }));
    recoverHandoff(id);
    expect(readHandoff(id).issues).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ callKey: source.callKey, source, response: { newIssues: [issue], dispositions: [] }, role: "writer" }));
    recoverHandoff(id);
    expect(readHandoff(id).issues).toHaveLength(1);
  });

  it("審查核准時仍有未結事項會拒絕，正式結案後才放行", () => {
    const created = mergeHandoff("f-i", source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    expect(reviewHandoffGate(created, "code", "approve")).toMatch(/未結/);
    expect(reviewHandoffGate(created, "code", "changes_requested")).toBeUndefined();
    const id = created.issues[0]!.id;
    const reviewer = { stage: "review" as const, step: "review", agent: "claude", callKey: "f-i:review" };
    const settled = previewHandoff(created, reviewer.callKey, reviewer, {
      newIssues: [], dispositions: [{ id, status: "resolved", reason: "測試已補齊", evidence: "src/api.test.ts:25" }],
    }, "reviewer");
    expect(reviewHandoffGate(settled, "code", "approve")).toBeUndefined();
  });
});

describe("指定 .flow 目錄的交接檔", () => {
  it("prepareHandoff 寫到指定目錄並只刪那裡的回覆，不動預設目錄", () => {
    const id = "f-custom-flow";
    mergeHandoff(id, source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const custom = mkdtempSync(join(tmpdir(), "agentflowctl-flow-"));
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "handoff-response.json"), JSON.stringify(empty));
    writeFileSync(join(custom, "handoff-response.json"), JSON.stringify(empty));

    prepareHandoff(id, "k", "code", false, custom);

    expect(readFileSync(join(custom, "handoff-context.md"), "utf8")).toContain("測試未涵蓋逾時");
    expect(existsSync(join(custom, "handoff-response.json"))).toBe(false);
    expect(existsSync(join(flowDir(id), "handoff-response.json"))).toBe(true);
    expect(existsSync(join(flowDir(id), "handoff-context.md"))).toBe(false);
  });

  it("validateHandoffResponse 讀指定目錄的回覆", () => {
    const custom = mkdtempSync(join(tmpdir(), "agentflowctl-flow-"));
    writeFileSync(join(custom, "handoff-response.json"), JSON.stringify(empty));
    expect(validateHandoffResponse("f-custom-flow-2", custom).ok).toBe(true);
    expect(validateHandoffResponse("f-custom-flow-2", join(custom, "不存在")).ok).toBe(false);
  });
});
