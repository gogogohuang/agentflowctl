import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const mode = readFileSync(".flow/review-mode.txt", "utf8").trim();
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

async function reviewRun(id: string, mode: "open" | "close", quorum = 1) {
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
