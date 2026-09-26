import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-engine-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "base.txt"), "base\n");
execFileSync("git", ["-C", root, "add", "base.txt"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const script = join(root, "reviewer.mjs");
writeFileSync(script, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = readFileSync(".flow/review-mode.txt", "utf8").trim();
if (existsSync(".flow/tamper-review.txt")) writeFileSync(".flow/acceptance.json", "[]");
const context = readFileSync(".flow/handoff-context.md", "utf8");
const id = context.match(/## ([a-f0-9]+)：/)?.[1];
writeFileSync(mode.startsWith("plan-") ? ".flow/plan-review.json" : ".flow/review.json", JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({
  newIssues: [],
  dispositions: mode.endsWith("close") && id ? [{ id, status: "resolved", reason: "已核對測試", evidence: "src/api.test.ts:25" }] : [],
}));
`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({
  agents: { a: { adapter: "command", command: ["node", script] }, b: { adapter: "command", command: ["node", script] } },
  cycle: ["a", "b"],
}));

const { addWorktree, commitAll } = await import("./git.js");
const { advance } = await import("./engine.js");
const { mergeHandoff, readHandoff } = await import("./handoff.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { agentRuns } = await import("./store.js");

async function reviewRun(id: string, mode: "open" | "close", quorum = 1, tamper = false) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b", "c"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
    cycle: ["a", "b", "c"], reviewQuorum: quorum,
  }));
  const wt = worktreeDir(id);
  await addWorktree(root, wt, "main", `flow/${id}`);
  writeFileSync(join(wt, "feature.ts"), "export const answer = 42;\n");
  await commitAll(wt, "feat: 測試功能 [a]");
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "review-mode.txt"), mode);
  if (tamper) {
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "匯出 answer" }]));
    writeFileSync(join(flowDir(id), "tamper-review.txt"), "");
  }
  const source = { stage: "implement" as const, step: "T-1-code", agent: "a", callKey: `${id}:code` };
  mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "測試待核對", evidence: "src/api.test.ts:20", targetStage: "code" }], dispositions: [] }, "writer");
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "review" as const,
    autopilot: true, maxAgentRuns: 10, cycle: ["a", "b", "c"], lastWriter: "a", attempts: {},
    taskIndex: 1, taskPhase: "tests" as const, createdAt: now, updatedAt: now,
  });
}

describe("審查交接關卡", () => {
  it("審查核准卻未處理 action 時不會開 PR", async () => {
    const run = await reviewRun("f-review-open", "open");
    expect(run.stage).toBe("failed");
    expect(run.failedStage).toBe("review");
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toMatch(/未結/);
  });

  it("審查者附證據結案後才進入 PR", async () => {
    const run = await reviewRun("f-review-close", "close");
    expect(run.stage).toBe("done");
    expect(readHandoff(run.id).issues[0]?.status).toBe("resolved");
  });

  it("多位審查者的交接各自保存，全部核准才進入 PR", async () => {
    const run = await reviewRun("f-review-panel", "close", 2);
    expect(run.stage).toBe("done");
    const ledger = readHandoff(run.id);
    expect(ledger.issues[0]?.status).toBe("resolved");
    expect(ledger.appliedCalls).toHaveLength(3); // 一位作者、兩位審查者
  });

  it("程式碼審查者修改驗收條件時會被還原", async () => {
    const run = await reviewRun("f-review-tamper", "close", 1, true);
    expect(run.stage).toBe("done");
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "acceptance.json"), "utf8"))).toEqual([{ id: "AC-1", description: "匯出 answer" }]);
  });

  it("計畫審查核准仍有未結事項時不能開始實作", async () => {
    const id = "f-plan-open";
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "review-mode.txt"), "plan-open");
    const source = { stage: "spec" as const, step: "spec", agent: "a", callKey: `${id}:spec` };
    mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "計畫待核對", evidence: "spec.md:2", targetStage: "plan" }], dispositions: [] }, "writer");
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 10, cycle: ["a", "b", "c"], planWriter: "a", attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.stage).toBe("failed");
    expect(run.failedStage).toBe("plan_review");
    expect(readFileSync(join(flowDir(id), "feedback.md"), "utf8")).toMatch(/未結/);
  });

  it("後面輪次的重試次數與先前輪次相同時，審查者的結案仍會套用", async () => {
    const id = "f-plan-rekey";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b", "c"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["a", "b", "c"],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "review-mode.txt"), "plan-close");
    const source = { stage: "spec" as const, step: "spec", agent: "a", callKey: `${id}:spec` };
    mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "計畫待核對", evidence: "spec.md:2", targetStage: "plan" }], dispositions: [] }, "writer");
    // 先前某一輪計畫審查時的重試次數剛好也是 {}：只靠重試次數組成的識別碼會和這次相同
    for (const agent of ["b", "c"]) {
      const key = JSON.stringify([id, "plan_review", "plan-review", 0, "tests", [], 0, agent]);
      mergeHandoff(id, key, { stage: "plan_review", step: "plan-review", agent, callKey: key }, { newIssues: [], dispositions: [] }, "reviewer");
    }
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 1, cycle: ["a", "b", "c"], planWriter: "a", attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.failureReason).not.toMatch(/矛盾/);
    expect(readHandoff(id).issues[0]?.status).toBe("resolved");
  });
});

const implementer = join(root, "implementer.mjs");
writeFileSync(implementer, `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const phase = prompt.includes("<red_output>") ? "code" : "tests";
writeFileSync(\`.flow/prompt-\${phase}.txt\`, prompt);
if (existsSync(".flow/feedback.md")) writeFileSync(\`.flow/feedback-\${phase}.txt\`, readFileSync(".flow/feedback.md"));
if (existsSync(\`.flow/tamper-\${phase}.txt\`)) {
  rmSync(\`.flow/tamper-\${phase}.txt\`);
  writeFileSync(".flow/acceptance.json", "[]");
}
if (phase === "tests") writeFileSync("feature.test.mjs", 'import { answer } from "./feature.mjs";\\nif (answer !== 42) process.exit(1);\\n');
else writeFileSync("feature.mjs", "export const answer = 42;\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function implementRun(id: string, acceptance: unknown, { maxAgentRuns = 2, tamper }: { maxAgentRuns?: number; tamper?: "tests" | "code" } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
    cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
  }));
  const wt = worktreeDir(id);
  await addWorktree(root, wt, "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "回傳答案", description: "匯出 answer", dependsOn: [], acceptance: ["AC-2"] },
  ]));
  if (tamper) writeFileSync(join(flowDir(id), `tamper-${tamper}.txt`), "");
  const now = new Date().toISOString();
  // 紅燈、綠燈各執行一次 agent（加上重試次數）後就達到上限而停下，只檢查 implement 的結果
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns, cycle: ["a", "b"], attempts: {},
    taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
  });
}

describe("實作階段", () => {
  it("紅綠燈 prompt 只帶入目前任務的驗收條件", async () => {
    const run = await implementRun("f-impl-ac", [
      { id: "AC-1", description: "其他任務的條件" },
      { id: "AC-2", description: "匯出 answer 為 42" },
    ]);
    expect(run.taskIndex).toBe(1);
    expect(run.failureReason).toMatch(/達到上限/);
    for (const phase of ["tests", "code"]) {
      const prompt = readFileSync(join(flowDir(run.id), `prompt-${phase}.txt`), "utf8");
      const acceptance = prompt.match(/<acceptance>([\s\S]*?)<\/acceptance>/)?.[1] ?? "";
      expect(acceptance).toContain("匯出 answer 為 42");
      expect(acceptance).not.toContain("AC-1");
    }
  });

  it("任務對應的驗收條件不存在時停在實作階段並說明原因", async () => {
    const run = await implementRun("f-impl-missing-ac", [{ id: "AC-1", description: "其他任務的條件" }]);
    expect(run.stage).toBe("failed");
    expect(run.failedStage).toBe("implement");
    expect(run.failureReason).toContain("AC-2 不存在");
  });

  it.each(["tests", "code"] as const)("%s 階段修改驗收條件時還原並重試", async (phase) => {
    const acceptance = [
      { id: "AC-1", description: "其他任務的條件" },
      { id: "AC-2", description: "匯出 answer 為 42" },
    ];
    const run = await implementRun(`f-impl-tamper-${phase}`, acceptance, { maxAgentRuns: 3, tamper: phase });
    expect(run.taskIndex).toBe(1);
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "acceptance.json"), "utf8"))).toEqual(acceptance);
    expect(agentRuns(run.id)).toBe(3);
    expect(readFileSync(join(flowDir(run.id), `feedback-${phase}.txt`), "utf8")).toContain("不可修改規格與計畫檔");
    expect(existsSync(join(worktreeDir(run.id), "feature.test.mjs"))).toBe(true);
  });
});

const fixer = join(root, "fixer.mjs");
writeFileSync(fixer, `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
writeFileSync(".flow/feedback-seen.txt", readFileSync(".flow/feedback.md"));
if (existsSync(".flow/tamper-fix.txt")) {
  rmSync(".flow/tamper-fix.txt");
  writeFileSync(".flow/acceptance.json", "[]");
}
writeFileSync("fixed.txt", String(Date.now()));
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

describe("修正階段", () => {
  it("修改驗收條件時還原並帶著原本的意見重試", async () => {
    const id = "f-fix-tamper";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", fixer] }])),
      cycle: ["a", "b"], install: "true", test: "true", checks: [],
    }));
    const acceptance = [{ id: "AC-1", description: "匯出 answer" }];
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(join(flowDir(id), "feedback.md"), "型別檢查失敗");
    writeFileSync(join(flowDir(id), "tamper-fix.txt"), "");
    const now = new Date().toISOString();
    // 第一次修正偷改被退回，第二次修正後 verify 通過，接著審查時達到 agent 次數上限而停下
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "fix", fixSource: "verify",
      autopilot: true, maxAgentRuns: 2, cycle: ["a", "b"], lastWriter: "a", attempts: {},
      taskIndex: 1, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.failureReason).toMatch(/達到上限/);
    expect(agentRuns(id)).toBe(2);
    expect(JSON.parse(readFileSync(join(flowDir(id), "acceptance.json"), "utf8"))).toEqual(acceptance);
    const feedback = readFileSync(join(flowDir(id), "feedback-seen.txt"), "utf8");
    expect(feedback).toContain("型別檢查失敗");
    expect(feedback).toContain("不可修改規格與計畫檔");
  });
});
