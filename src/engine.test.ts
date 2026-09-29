import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { advance, resetQuotaState } = await import("./engine.js");
const { mergeHandoff, readHandoff } = await import("./handoff.js");
const { flowDir, logDir, planReviewStatePath, worktreeDir } = await import("./paths.js");
const { agentRuns, listRetries, listSubstitutions, listUsage } = await import("./store.js");

// 額度用完的 agent 記在 engine 模組層，同一個測試程序內不會自動清掉；每個測試都從沒有人額度用完開始
beforeEach(() => resetQuotaState());

async function reviewRun(id: string, mode: "open" | "close", quorum = 1, tamper = false, adaptive = false) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b", "c"].map((name) => [name, { adapter: "command", command: ["node", script, ...(adaptive ? ["{model}"] : [])],
      ...(adaptive ? { models: [{ name: "small", strength: "low" }, { name: "large", strength: "high" }], modelProbe: ["node", script, "{model}"] } : {}) }])),
    cycle: ["a", "b", "c"], reviewQuorum: quorum,
    ...(adaptive ? { modelSelection: { mode: "adaptive", stageStrength: { review: "low" } } } : {}),
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
    ...(adaptive ? { modelMode: "adaptive" as const } : {}),
    taskIndex: 1, taskPhase: "tests" as const, createdAt: now, updatedAt: now,
  });
}

describe("審查交接關卡", () => {
  it("審查核准卻未處理 action 時不會開 PR", async () => {
    const run = await reviewRun("f-review-open", "open");
    expect(run.stage).toBe("failed");
    expect(run.failedStage).toBe("review");
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toMatch(/未結/);
    const retries = listRetries(run.id);
    expect(retries.map((r) => r.category)).toContain("handoff_invalid");
    expect(retries.every((r) => r.key === "review-run")).toBe(true);
    expect(retries.at(-1)).toMatchObject({ final: true });
    expect(retries.slice(0, -1).every((r) => r.final === false)).toBe(true);
    expect(run.failureCategory).toBe("retry_limit");
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

  it("adaptive 審查依階段強度選模型，並把名稱寫入 log", async () => {
    const run = await reviewRun("f-review-adaptive", "close", 1, false, true);
    expect(run.stage).toBe("done");
    const file = readdirSync(logDir(run.id)).find((name) => name.includes("-review-"));
    expect(file).toBeDefined();
    expect(readFileSync(join(logDir(run.id), file!), "utf8").split("\n")[0]).toContain('"model":"small"');
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
    // 核准與未結事項矛盾時，reviewHandoffGate 在 finishHandoff 失敗，尚未進入 planSettled
    const retries = listRetries(id);
    expect(retries.map((r) => [r.key, r.category])).toContainEqual(["plan-review-run", "handoff_invalid"]);
    expect(retries.every((r) => r.key === "plan-review-run")).toBe(true);
    expect(retries.at(-1)).toMatchObject({ final: true });
  });

  it("後一位仲裁者要求修改並留下計畫事項時，定案重試為 open_handoff", async () => {
    const id = "f-plan-settle-open";
    const script = join(root, "plan-settle-open.mjs");
    // 兩家才會雙盲仲裁。先核准的人看不到之後才新增的事項，reviewHandoffGate 不會擋下這次定案。
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const agent = process.argv[2];
const prompt = readFileSync(0, "utf8");
if (prompt.includes("plan-arbiter.json")) {
  const approve = agent === "a";
  writeFileSync(".flow/plan-arbiter.json", JSON.stringify({
    verdict: approve ? "approve" : "changes_requested",
    items: [{ criterion: "範圍", status: approve ? "met" : "not_met", note: approve ? "可以執行" : "仍有缺口" }],
  }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify(approve
    ? { newIssues: [], dispositions: [] }
    : { newIssues: [{ kind: "action", summary: "計畫仍缺邊界", evidence: "plan.md:1", targetStage: "plan" }], dispositions: [] }));
} else {
  writeFileSync(".flow/plan-review.json", JSON.stringify({
    verdict: "changes_requested",
    items: [{ criterion: "範圍", status: "not_met", note: "仍有缺口" }],
  }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
}
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script, name] }])),
      cycle: ["a", "b"], planArbiter: true, tieBreak: "proceed",
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n");
    // 意見與上一輪相同，這一輪審查後直接交付仲裁，不依賴重試上限
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), `<issue criterion="範圍" status="not_met">仍有缺口</issue>`);
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 3, cycle: ["a", "b"], planWriter: "a", attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(readHandoff(id).issues).toEqual([
      expect.objectContaining({ kind: "action", targetStage: "plan", status: "open" }),
    ]);
    expect(listRetries(id).map((r) => [r.key, r.category])).toEqual([["plan-handoff", "open_handoff"]]);
    expect(run.failedStage).toBe("plan_fix");
    expect(run.failureCategory).toBe("agent_budget");
  });

  async function arbitrate(id: string, approver: string | undefined, tieBreak: "proceed" | "stop") {
    const script = join(root, `${id}.mjs`);
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const agent = process.argv[2];
const prompt = readFileSync(0, "utf8");
if (prompt.includes("plan-arbiter.json")) {
  const approve = agent === ${JSON.stringify(approver ?? "")};
  writeFileSync(".flow/plan-arbiter.json", JSON.stringify({
    verdict: approve ? "approve" : "changes_requested",
    items: [{ criterion: "範圍", status: approve ? "met" : "not_met", note: "仲裁意見" }],
  }));
} else {
  writeFileSync(".flow/plan-review.json", JSON.stringify({
    verdict: "changes_requested",
    items: [{ criterion: "範圍", status: "not_met", note: "仍有缺口" }],
  }));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script, name] }])),
      cycle: ["a", "b"], planArbiter: true, tieBreak,
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n");
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), `<issue criterion="範圍" status="not_met">仍有缺口</issue>`);
    const now = new Date().toISOString();
    return advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 3, cycle: ["a", "b"], planWriter: "a", attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
  }

  it("仲裁意見分歧且 tieBreak=stop 時，失敗原因記為 arbitration_stop", async () => {
    const run = await arbitrate("f-arb-stop", "a", "stop");
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("arbitration_stop");
    expect(listRetries(run.id)).toEqual([]);
  });

  it("仲裁要求修訂時記一筆 arbitration_revise；agent 次數用完時失敗原因為 agent_budget", async () => {
    const run = await arbitrate("f-arb-revise", undefined, "proceed");
    expect(listRetries(run.id).map((r) => [r.key, r.backTo, r.category, r.final])).toEqual([["plan-arbitration", "plan_fix", "arbitration_revise", false]]);
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("agent_budget");
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

  it("計畫審查者修改 .flow/plan-replies.md 時會被還原", async () => {
    const id = "f-plan-replies-tamper";
    const script = join(root, "plan-replies-tamper.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs";
writeFileSync(".flow/plan-replies.md", "被審查者亂改");
writeFileSync(".flow/plan-review.json", JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["r1", "r2"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["r1", "r2"],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n");
    writeFileSync(join(flowDir(id), "plan-replies.md"), "## 整體\n原本的回應\n");
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 3, cycle: ["r1", "r2"], planWriter: "r1", attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    // 計畫審查一次就核准（沒有因為改檔被判為交接矛盾而重試），代表覆寫在關卡判斷前已經還原
    expect(listRetries(run.id).map((r) => r.key)).not.toContain("plan-review-run");
    expect(readFileSync(join(flowDir(id), "plan-replies.md"), "utf8")).toBe("## 整體\n原本的回應\n");
  });
});

const implementer = join(root, "implementer.mjs");
writeFileSync(implementer, `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const phase = prompt.includes("<red_output>") ? "code" : prompt.includes("<no_tdd>") ? "direct" : "tests";
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

async function implementRun(
  id: string,
  acceptance: unknown,
  { maxAgentRuns = 2, tamper, tdd, test = "node feature.test.mjs" }: { maxAgentRuns?: number; tamper?: "tests" | "code"; tdd?: boolean; test?: string | null } = {},
) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
    cycle: ["a", "b"], install: "true", ...(test === null ? {} : { test }), checks: [],
  }));
  const wt = worktreeDir(id);
  await addWorktree(root, wt, "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "回傳答案", description: "匯出 answer", dependsOn: [], acceptance: ["AC-2"], ...(tdd === undefined ? {} : { tdd }) },
  ]));
  if (tamper) writeFileSync(join(flowDir(id), `tamper-${tamper}.txt`), "");
  const now = new Date().toISOString();
  // 紅燈、綠燈各執行一次 agent（加上重試次數）後就達到上限而停在任務審查前，只檢查紅綠燈的結果
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
    expect(run.taskPhase).toBe("review");
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
    expect(run.taskPhase).toBe("review");
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "acceptance.json"), "utf8"))).toEqual(acceptance);
    expect(agentRuns(run.id)).toBe(3);
    expect(readFileSync(join(flowDir(run.id), `feedback-${phase}.txt`), "utf8")).toContain("不可修改規格與計畫檔");
    expect(existsSync(join(worktreeDir(run.id), "feature.test.mjs"))).toBe(true);
  });
});

describe("略過 TDD", () => {
  const acceptance = [{ id: "AC-2", description: "匯出 answer 為 42" }];

  it("任務標 tdd:false 時不寫測試，直接實作，並跑既有測試當回歸檢查", async () => {
    const run = await implementRun("f-no-tdd-flag", acceptance, { maxAgentRuns: 1, tdd: false, test: "true" });
    expect(run.taskPhase).toBe("review");
    expect(agentRuns(run.id)).toBe(1);
    expect(existsSync(join(worktreeDir(run.id), "feature.test.mjs"))).toBe(false);
    expect(readFileSync(join(worktreeDir(run.id), "feature.mjs"), "utf8")).toContain("42");
    const prompt = readFileSync(join(flowDir(run.id), "prompt-direct.txt"), "utf8");
    expect(prompt).not.toContain("<red_output>");
    expect(prompt).toContain("匯出 answer 為 42");
  });

  it("專案沒有測試框架時，即使任務沒標 tdd 也直接實作，不跑測試", async () => {
    const run = await implementRun("f-no-tdd-framework", acceptance, { maxAgentRuns: 1, test: null });
    expect(run.taskPhase).toBe("review");
    expect(agentRuns(run.id)).toBe(1);
    expect(existsSync(join(worktreeDir(run.id), "feature.test.mjs"))).toBe(false);
    expect(existsSync(join(flowDir(run.id), "prompt-direct.txt"))).toBe(true);
  });

  it("有測試框架且沒標 tdd:false 時仍走紅綠燈", async () => {
    const run = await implementRun("f-tdd-default", acceptance);
    expect(existsSync(join(worktreeDir(run.id), "feature.test.mjs"))).toBe(true);
    expect(existsSync(join(flowDir(run.id), "prompt-direct.txt"))).toBe(false);
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

const worker = join(root, "worker.mjs");
writeFileSync(worker, `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const id = prompt.match(/"id": "(T-\\d+)"/)?.[1];
const role = prompt.includes("你是任務審查者") ? "task-review" : prompt.includes("你是程式碼審查者") ? "review"
  : prompt.includes("你是除錯工程師") ? "fix" : prompt.includes("<red_output>") ? "code" : "tests";
appendFileSync(".flow/steps.txt", \`\${role}\${role === "review" || role === "fix" ? "" : ":" + id}\\n\`);
if (role === "task-review" && existsSync(".flow/fail-review-once.txt")) {
  rmSync(".flow/fail-review-once.txt");
  process.exit(1);
}
if (role === "fix" && existsSync(".flow/fail-fix-once.txt")) {
  rmSync(".flow/fail-fix-once.txt");
  process.exit(1);
}
if (role === "tests") writeFileSync(\`\${id}.test.mjs\`, \`import { ok } from "./\${id}.mjs";\\nif (!ok) process.exit(1);\\n\`);
if (role === "code") writeFileSync(\`\${id}.mjs\`, "export const ok = true;\\n");
if (role === "fix") writeFileSync("fixed.txt", readFileSync(".flow/feedback.md"));
if (role === "task-review" || role === "review") {
  writeFileSync(\`.flow/diff-\${role}-\${id ?? "all"}.txt\`, readFileSync(".flow/diff.patch"));
  const reject = role === "task-review" && existsSync(".flow/reject-once.txt");
  if (reject) rmSync(".flow/reject-once.txt");
  writeFileSync(".flow/review.json", JSON.stringify(reject
    ? { verdict: "changes_requested", items: [{ criterion: "AC-1", status: "partial", note: "缺少邊界情況" }] }
    : { verdict: "approve", items: [] }));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function taskFlowRun(id: string, { tasks = 1, check = "true", rejectOnce = false,
  failReviewOnce = false, failFixOnce = false } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", worker] }])),
    cycle: ["a", "b"], install: "true", test: "for f in T-*.test.mjs; do node $f || exit 1; done",
    checks: [{ name: "check", cmd: check }],
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  const ids = Array.from({ length: tasks }, (_, i) => `T-${i + 1}`);
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(ids.map((t, i) => ({ id: `AC-${i + 1}`, description: `${t} 完成` }))));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify(ids.map((t, i) => (
    { id: t, title: `任務 ${t}`, description: `完成 ${t}`, dependsOn: [], acceptance: [`AC-${i + 1}`] }
  ))));
  if (rejectOnce) writeFileSync(join(flowDir(id), "reject-once.txt"), "");
  if (failReviewOnce) writeFileSync(join(flowDir(id), "fail-review-once.txt"), "");
  if (failFixOnce) writeFileSync(join(flowDir(id), "fail-fix-once.txt"), "");
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns: 20, cycle: ["a", "b"], attempts: {},
    taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
  });
}

const steps = (id: string) => readFileSync(join(flowDir(id), "steps.txt"), "utf8").trim().split("\n");

describe("任務審查與驗證", () => {
  it("審查執行失敗後有有效結果，就清除執行失敗次數", async () => {
    const run = await taskFlowRun("f-task-review-retry-clear", { failReviewOnce: true });
    expect(run.stage).toBe("done");
    expect(run.attempts["T-1:review-run"]).toBeUndefined();
  });

  it("任務修正失敗後成功，就清除修正失敗次數", async () => {
    const run = await taskFlowRun("f-task-fix-retry-clear", { rejectOnce: true, failFixOnce: true });
    expect(run.stage).toBe("done");
    expect(run.attempts["T-1:fix"]).toBeUndefined();
  });

  it("每個任務依序寫測試、實作、審查、驗證，全部完成後再做整體審查", async () => {
    const run = await taskFlowRun("f-task-order", { tasks: 2 });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("done");
    expect(steps(run.id)).toEqual(["tests:T-1", "code:T-1", "task-review:T-1", "tests:T-2", "code:T-2", "task-review:T-2", "review"]);
    const logs = readdirSync(logDir(run.id));
    expect(logs.findIndex((f) => f.includes("T-1-check"))).toBeLessThan(logs.findIndex((f) => f.includes("T-2-tests")));
  });

  it("任務審查只看這個任務的變更，整體審查看全部", async () => {
    const run = await taskFlowRun("f-task-diff", { tasks: 2 });
    const second = readFileSync(join(flowDir(run.id), "diff-task-review-T-2.txt"), "utf8");
    expect(second).toContain("T-2.mjs");
    expect(second).not.toContain("T-1.mjs");
    const whole = readFileSync(join(flowDir(run.id), "diff-review-all.txt"), "utf8");
    expect(whole).toContain("T-1.mjs");
    expect(whole).toContain("T-2.mjs");
  });

  it("任務審查要求修改時，修正後重新審查再驗證", async () => {
    const run = await taskFlowRun("f-task-reject", { rejectOnce: true });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("done");
    expect(steps(run.id)).toEqual(["tests:T-1", "code:T-1", "task-review:T-1", "fix", "task-review:T-1", "review"]);
    expect(readFileSync(join(worktreeDir(run.id), "fixed.txt"), "utf8")).toContain("缺少邊界情況");
    const log = execFileSync("git", ["-C", worktreeDir(run.id), "log", "--format=%s"], { encoding: "utf8" });
    expect(log).toMatch(/^fix\(T-1\): 依 \S+ 的審查意見 \[\S+\]$/m);
  });

  it("任務驗證失敗時，修正後重新審查再驗證，通過才換下一個任務", async () => {
    const run = await taskFlowRun("f-task-verify", { tasks: 2, check: "test -f fixed.txt" });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("done");
    expect(steps(run.id)).toEqual(["tests:T-1", "code:T-1", "task-review:T-1", "fix", "task-review:T-1", "tests:T-2", "code:T-2", "task-review:T-2", "review"]);
    expect(readFileSync(join(worktreeDir(run.id), "fixed.txt"), "utf8")).toContain("check 失敗");
  });
});

const quotaAgent = join(root, "quota-agent.mjs");
writeFileSync(quotaAgent, `import { readFileSync, writeFileSync } from "node:fs";
const [name, quota] = process.argv.slice(2);
if (quota === "quota") {
  console.error("usage limit reached");
  process.exit(1);
}
const prompt = readFileSync(0, "utf8");
if (prompt.includes("你是程式碼審查者")) writeFileSync(".flow/review.json", JSON.stringify({ verdict: "approve", items: [] }));
else writeFileSync(\`fixed-\${name}.txt\`, "ok\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function quotaRun(id: string, stage: "fix" | "review", exhausted: string, models: Record<string, Array<{ name: string; strength: string }>>) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(Object.entries(models).map(([name, list]) => [name, {
      adapter: "command", command: ["node", quotaAgent, name, name === exhausted ? "quota" : "ok", "{model}"],
      modelProbe: ["node", quotaAgent, "{model}"], models: list,
    }])),
    cycle: Object.keys(models), install: "true", test: "true", checks: [], modelSelection: { mode: "adaptive" },
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  writeFileSync(join(worktreeDir(id), "feature.ts"), "export const answer = 42;\n");
  await commitAll(worktreeDir(id), "feat: 測試功能 [a]");
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "feedback.md"), "測試失敗");
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage, fixSource: "verify",
    autopilot: true, maxAgentRuns: 3, cycle: Object.keys(models), lastWriter: "a", attempts: {}, modelMode: "adaptive",
    taskIndex: 1, taskPhase: "tests", createdAt: now, updatedAt: now,
  });
}

describe("adaptive 選模與流程串接", () => {
  it("寫入步驟額度用完時，代打者從自己的模型清單重新選模", async () => {
    const run = await quotaRun("f-model-sub", "fix", "a", {
      a: [{ name: "a-small", strength: "low" }],
      b: [{ name: "b-small", strength: "low" }, { name: "b-large", strength: "high" }],
    });
    expect(listSubstitutions(run.id)).toMatchObject([{ step: "fix", planned: "a", actual: "b" }]);
    const fix = listUsage(run.id).filter((e) => e.stage === "fix").map((e) => ({ agent: e.agent, model: e.model }));
    expect(fix).toEqual([{ agent: "a", model: "a-small" }, { agent: "b", model: "b-large" }]);
    expect(existsSync(join(worktreeDir(run.id), "fixed-b.txt"))).toBe(true);
  });

  it("審查者額度用完時暫停，不計入選模失敗也不升級", async () => {
    const run = await quotaRun("f-model-review-quota", "review", "b", {
      a: [{ name: "a-large", strength: "high" }],
      b: [{ name: "b-large", strength: "high" }],
    });
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("review");
    expect(run.pauseReason).toContain("b 的額度已用完");
    expect(run.modelRetryAttempts ?? {}).toEqual({});
    expect(listSubstitutions(run.id)).toEqual([]);
  });

  it("resetQuotaState 之後，先前額度用完的 b 仍可審查", async () => {
    // 同一個測試內先讓 b 額度用完，不依賴其他測試的執行順序
    const models = { a: [{ name: "a-large", strength: "high" }], b: [{ name: "b-large", strength: "high" }] };
    const paused = await quotaRun("f-model-review-before-reset", "review", "b", models);
    expect(paused.stage).toBe("paused");
    resetQuotaState();
    const run = await quotaRun("f-model-review-after-reset", "review", "none", models);
    expect(run.stage).not.toBe("paused");
    expect(listUsage(run.id).map((e) => e.agent)).toContain("b");
  });

  it("舊 run 的任務沒有難度時，選模視為 medium", async () => {
    const id = "f-model-legacy-task";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["c", "d"].map((name) => [name, {
        adapter: "command", command: ["node", worker, "{model}"], modelProbe: ["node", worker, "{model}"],
        models: [{ name: "small", strength: "low" }, { name: "middle", strength: "medium" }, { name: "large", strength: "high" }],
      }])),
      cycle: ["c", "d"], install: "true", test: "for f in T-*.test.mjs; do node $f || exit 1; done", checks: [],
      modelSelection: { mode: "adaptive" },
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "T-1 完成" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "任務 T-1", description: "完成 T-1", dependsOn: [], acceptance: ["AC-1"] },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 20, cycle: ["c", "d"], attempts: {}, modelMode: "adaptive",
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.stage).toBe("done");
    const models = Object.fromEntries(listUsage(run.id).map((e) => [e.stage, e.model]));
    expect(models).toMatchObject({ "T-1-tests": "middle", "T-1-code": "middle", "T-1-review": "middle", review: "large" });
  });
});

function layeredTasks() {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `T-${i + 1}`,
    title: `任務 ${i + 1}`,
    description: i < 4 ? "改 src/a.ts" : "改 src/b.ts",
    dependsOn: [] as string[],
    acceptance: [`AC-${i + 1}`],
    complexity: "low",
  }));
}

type LayeredTask = ReturnType<typeof layeredTasks>[number];

function writeTasks(id: string, tasks: LayeredTask[]) {
  writeFileSync(join(flowDir(id), "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify(tasks));
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(tasks.map((item) => ({ id: item.acceptance[0], description: `${item.id} 行為` }))));
  writeFileSync(join(flowDir(id), "plan.md"), ["# 計畫", "整體做法", "", ...tasks.flatMap((item) => [`## ${item.id} 難度`, "低"])].join("\n") + "\n");
}

/** 準備一個停在 plan_review、有八個任務分成兩群的 run；body 是審查 agent 腳本在讀完 prompt 之後的內容 */
async function layeredRun(
  id: string, body: string,
  opts: { agents?: string[]; quorum?: number; planArbiter?: boolean; layers?: Record<string, unknown> } = {},
) {
  const agents = opts.agents ?? ["p1", "p2", "p3"];
  const script = join(root, `${id}.mjs`);
  writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const kind = prompt.includes("計畫索引審查者") ? "index" : prompt.includes("計畫群審查者") ? "group" : prompt.includes("plan-arbiter.json") ? "arbiter" : "other";
appendFileSync(".flow/seen-prompts.txt", kind + "\\n");
const file = kind === "group" ? ".flow/plan-review-group.json" : ".flow/plan-review.json";
${body}
`);
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(agents.map((name) => [name, { adapter: "command", command: ["node", script] }])),
    cycle: agents, planReviewQuorum: opts.quorum ?? 1, planArbiter: opts.planArbiter ?? true,
    ...(opts.layers ? { planReviewLayers: opts.layers } : {}),
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
  writeTasks(id, layeredTasks());
}

function planReviewRun(id: string, maxAgentRuns: number, agents = ["p1", "p2", "p3"]) {
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
    autopilot: true, maxAgentRuns, cycle: agents, planWriter: agents[0], attempts: {},
    taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
  });
}

const APPROVE = `writeFileSync(file, JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));`;

const OBJECT = `if (kind === "arbiter") {
  writeFileSync(".flow/plan-arbiter.json", JSON.stringify({ verdict: "changes_requested", items: [{ criterion: "範圍", status: "not_met", note: "仲裁意見" }] }));
} else {
  writeFileSync(file, JSON.stringify({
    verdict: "changes_requested",
    items: [{ criterion: kind === "index" ? "需求覆蓋" : "任務群", status: "not_met", note: kind === "index" ? "缺逾時" : "太大" }],
  }));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));`;

const seen = (id: string) => readFileSync(join(flowDir(id), "seen-prompts.txt"), "utf8");
const resetSeen = (id: string) => writeFileSync(join(flowDir(id), "seen-prompts.txt"), "");
const reviewState = (id: string) => JSON.parse(readFileSync(planReviewStatePath(id), "utf8"));

describe("分層計畫審查", () => {
  it("八個任務分成兩群時先審索引再審每一群，狀態寫在 run 目錄", async () => {
    const id = "f-plan-layers";
    await layeredRun(id, APPROVE);
    const run = await planReviewRun(id, 3);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(seen(id)).toBe("index\ngroup\ngroup\n");
    const state = reviewState(id);
    expect(state.reviewed.tasks["T-1"].verdict).toBe("approve");
    expect(state.reviewed.tasks["T-8"].verdict).toBe("approve");
    expect(state.round).toBeUndefined();
    expect(existsSync(join(flowDir(id), "plan-review-state.json"))).toBe(false);
  });

  it("索引 prompt 帶全部任務描述、驗收條文與整體做法，並要求讀規格", async () => {
    const id = "f-plan-layers-index";
    await layeredRun(id, `if (kind === "index") writeFileSync(".flow/index-prompt.txt", prompt);
${APPROVE}`);
    await planReviewRun(id, 3);
    const prompt = readFileSync(join(flowDir(id), "index-prompt.txt"), "utf8");
    expect(prompt).toContain("T-8 行為");
    expect(prompt).toContain("改 src/b.ts");
    expect(prompt).toContain("整體做法");
    expect(prompt).toContain(".flow/spec.md");
  });

  it("已核准且內容沒變的群不會重審", async () => {
    const id = "f-plan-layers-skip";
    await layeredRun(id, APPROVE);
    await planReviewRun(id, 3);
    resetSeen(id);
    const run = await planReviewRun(id, 4);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(seen(id)).toBe("index\n");
  });

  it("只改某任務的難度證據時只重審那一群，改了整體做法時所有群都重審", async () => {
    const id = "f-plan-layers-plan-md";
    await layeredRun(id, APPROVE);
    await planReviewRun(id, 3);
    const planPath = join(flowDir(id), "plan.md");
    writeFileSync(planPath, readFileSync(planPath, "utf8").replace("## T-5 難度\n低", "## T-5 難度\n中：要協調兩個模組"));
    resetSeen(id);
    // agent 執行上限依 costs.jsonl 累計，所以每次都要加上前面已用掉的次數
    await planReviewRun(id, 5);
    expect(seen(id)).toBe("index\ngroup\n");
    writeFileSync(planPath, readFileSync(planPath, "utf8").replace("整體做法", "改用另一種做法"));
    resetSeen(id);
    await planReviewRun(id, 8);
    expect(seen(id)).toBe("index\ngroup\ngroup\n");
  });

  it("六個任務仍走整份審查，並刪掉先前的分層狀態", async () => {
    const id = "f-plan-layers-small";
    await layeredRun(id, APPROVE, { agents: ["p1", "p2"] });
    writeTasks(id, layeredTasks().slice(0, 6).map((item, i) => ({ ...item, description: i < 3 ? "改 src/a.ts" : "改 src/b.ts" })));
    mkdirSync(join(planReviewStatePath(id), ".."), { recursive: true });
    writeFileSync(planReviewStatePath(id), JSON.stringify({ version: 1 }));
    await planReviewRun(id, 1, ["p1", "p2"]);
    expect(seen(id)).toBe("other\n");
    expect(existsSync(planReviewStatePath(id))).toBe(false);
  });

  it("plan.md 缺任務標題時改走整份審查", async () => {
    const id = "f-plan-layers-headings";
    await layeredRun(id, APPROVE);
    writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n整體做法\n");
    const log = vi.spyOn(console, "log");
    try {
      await planReviewRun(id, 1);
      expect(log.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining(
        "📋 這次計畫審查讀整份計畫：plan.md 缺少 T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8 的「## T-<數字>」標題",
      ));
    } finally {
      log.mockRestore();
    }
    expect(seen(id)).toBe("other\n");
    expect(existsSync(planReviewStatePath(id))).toBe(false);
  });

  it("設定關閉時一律整份審查", async () => {
    const id = "f-plan-layers-off";
    await layeredRun(id, APPROVE, { layers: { enabled: false } });
    const log = vi.spyOn(console, "log");
    try {
      await planReviewRun(id, 1);
      expect(log.mock.calls.some((call) => String(call[0]).includes("📋 這次計畫審查"))).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(seen(id)).toBe("other\n");
  });

  it("索引人數依 planReviewQuorum，只有低難度任務的群仍只有一位", async () => {
    const id = "f-plan-layers-quorum";
    await layeredRun(id, APPROVE, { quorum: 2 });
    const run = await planReviewRun(id, 4);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(seen(id)).toBe("index\nindex\ngroup\ngroup\n");
  });

  it("含高難度任務的群由 planReviewQuorum 位審查", async () => {
    const id = "f-plan-layers-high";
    await layeredRun(id, APPROVE, { quorum: 2 });
    writeTasks(id, layeredTasks().map((item) => item.id === "T-1" ? { ...item, complexity: "high" } : item));
    const run = await planReviewRun(id, 5);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(seen(id)).toBe("index\nindex\ngroup\ngroup\ngroup\n");
  });

  it("索引與群的未通過意見一起寫進指紋", async () => {
    const id = "f-plan-layers-fingerprint";
    await layeredRun(id, OBJECT, { agents: ["p1", "p2"] });
    const run = await planReviewRun(id, 3, ["p1", "p2"]);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(readFileSync(join(flowDir(id), "plan-review-last.txt"), "utf8")).toBe([
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="需求覆蓋" status="not_met">缺逾時</issue>',
    ].join("\n"));
    expect(reviewState(id).reviewed.tasks["T-1"].verdict).toBe("changes_requested");
  });

  it("僵持交付仲裁、仲裁要求修訂時刪掉審查狀態", async () => {
    const id = "f-plan-layers-arbiter";
    await layeredRun(id, OBJECT, { agents: ["p1", "p2"] });
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), [
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="需求覆蓋" status="not_met">缺逾時</issue>',
    ].join("\n"));
    const run = await planReviewRun(id, 5, ["p1", "p2"]);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(listRetries(id).some((item) => item.category === "arbitration_revise")).toBe(true);
    expect(existsSync(planReviewStatePath(id))).toBe(false);
  });

  it("索引核准卻未結案時停在 plan_review，且不寫狀態", async () => {
    const id = "f-plan-layers-handoff";
    await layeredRun(id, APPROVE);
    const source = { stage: "spec" as const, step: "spec", agent: "p1", callKey: `${id}:spec` };
    mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "計畫待核對", evidence: "spec.md:2", targetStage: "plan" }], dispositions: [] }, "writer");
    const run = await planReviewRun(id, 3);
    expect(run.failedStage).toBe("plan_review");
    expect(listRetries(id).some((item) => item.key === "plan-review-run" && item.category === "handoff_invalid")).toBe(true);
    expect(existsSync(planReviewStatePath(id))).toBe(false);
  });

  it("索引要求修改並留下事項時，群核准不算交接矛盾", async () => {
    const id = "f-plan-layers-group-gate";
    await layeredRun(id, `if (kind === "index") {
  writeFileSync(file, JSON.stringify({ verdict: "changes_requested", items: [{ criterion: "需求覆蓋", status: "not_met", note: "缺逾時" }] }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [{ kind: "action", summary: "補逾時", evidence: "需求第 1 句", targetStage: "plan" }], dispositions: [] }));
} else {
${APPROVE}
}`);
    const run = await planReviewRun(id, 3);
    expect(seen(id)).toBe("index\ngroup\ngroup\n");
    expect(listRetries(id).map((item) => [item.key, item.category])).toEqual([["plan-review", "review_changes"]]);
    expect(run.failureReason).toMatch(/達到上限/);
  });

  it("某一群格式錯誤時重跑同一輪，已成功的索引與群不重跑", async () => {
    const id = "f-plan-layers-resume";
    await layeredRun(id, `if (kind === "group" && prompt.includes("G-2") && !existsSync(".flow/g2-failed")) {
  writeFileSync(".flow/g2-failed", "");
  writeFileSync(file, "{");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    const run = await planReviewRun(id, 4);
    expect(run.failureReason).toMatch(/達到上限/);
    expect(seen(id)).toBe("index\ngroup\ngroup\ngroup\n");
    expect(listRetries(id).map((item) => [item.key, item.category])).toEqual([["plan-review-run", "format_invalid"]]);
    const state = reviewState(id);
    expect(state.reviewed.tasks["T-8"].verdict).toBe("approve");
    expect(state.round).toBeUndefined();
  });

  it("同一輪內三個不同呼叫各失敗一次，只要每次重跑都有進展就能完成這一輪", async () => {
    const id = "f-plan-layers-progress";
    // 索引、G-1、G-2 各在第一次格式錯誤；每次重跑都有一個呼叫真的成功，不該累計到重試上限
    await layeredRun(id, `const mark = kind === "index" ? "index" : prompt.includes("任務群 G-1") ? "g1" : "g2";
if (kind !== "other" && !existsSync(".flow/failed-" + mark)) {
  writeFileSync(".flow/failed-" + mark, "");
  writeFileSync(file, "{");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    const run = await planReviewRun(id, 6);
    expect(listRetries(id).map((item) => [item.key, item.final])).toEqual([
      ["plan-review-run", false], ["plan-review-run", false], ["plan-review-run", false],
    ]);
    expect(run.failedStage).toBe("implement");
    expect(run.failureCategory).toBe("agent_budget");
    expect(reviewState(id).reviewed.tasks["T-8"].verdict).toBe("approve");
  });

  it("整份審查時同一呼叫連續失敗仍計入重試上限", async () => {
    const id = "f-plan-full-run-limit";
    await layeredRun(id, `writeFileSync(file, "{");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));`, { layers: { enabled: false } });
    const run = await planReviewRun(id, 10);
    expect(run.failureCategory).toBe("retry_limit");
    expect(listRetries(id).map((item) => item.key)).toEqual(["plan-review-run", "plan-review-run", "plan-review-run"]);
  });

  it("plan-fix 沒寫 plan-replies.md 時，下一輪不會讀到上一輪的回應", async () => {
    const id = "f-plan-replies-stale";
    await layeredRun(id, `if (kind === "index") writeFileSync(".flow/index-prompt.txt", prompt);
if (prompt.includes("計畫修訂者")) {
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    writeFileSync(join(flowDir(id), "plan-replies.md"), "## 整體\n上一輪的舊回應\n");
    const now = new Date().toISOString();
    await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_fix",
      autopilot: true, maxAgentRuns: 2, cycle: ["p1", "p2", "p3"], planWriter: "p1", planReviewer: "p2", attempts: { "plan-review": 1 },
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(existsSync(join(flowDir(id), "plan-replies.md"))).toBe(false);
    expect(readFileSync(join(flowDir(id), "index-prompt.txt"), "utf8")).not.toContain("上一輪的舊回應");
  });

  it("plan-fix 失敗時還原 plan-replies.md", async () => {
    const id = "f-plan-replies-restore";
    await layeredRun(id, `writeFileSync(".flow/tasks.json", "{");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));`);
    writeFileSync(join(flowDir(id), "plan-replies.md"), "## 整體\n上一輪的舊回應\n");
    const now = new Date().toISOString();
    await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_fix",
      autopilot: true, maxAgentRuns: 1, cycle: ["p1", "p2", "p3"], planWriter: "p1", planReviewer: "p2", attempts: { "plan-review": 1 },
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(readFileSync(join(flowDir(id), "plan-replies.md"), "utf8")).toBe("## 整體\n上一輪的舊回應\n");
  });

  it("plan-fix 因所有 agent 額度用完而暫停時，還原計畫檔與 plan-replies.md", async () => {
    const id = "f-plan-fix-quota";
    // 每一家都先改計畫與回應、再回報額度用完：代打者也用完後暫停，檔案要回到進入 plan_fix 時的樣子
    await layeredRun(id, `if (prompt.includes("計畫修訂者")) {
  writeFileSync(".flow/plan.md", "被改掉的計畫");
  writeFileSync(".flow/plan-replies.md", "半成品回應");
  console.error("usage limit reached");
  process.exit(1);
}
${APPROVE}`, { agents: ["p1", "p2"] });
    writeFileSync(join(flowDir(id), "plan-replies.md"), "## 整體\n上一輪的舊回應\n");
    const planBefore = readFileSync(join(flowDir(id), "plan.md"), "utf8");
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_fix",
      autopilot: true, maxAgentRuns: 10, cycle: ["p1", "p2"], planWriter: "p1", planReviewer: "p2", attempts: { "plan-review": 1 },
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("plan_fix");
    expect(run.pauseReason).toContain("所有 agent 的額度都已用完");
    expect(readFileSync(join(flowDir(id), "plan.md"), "utf8")).toBe(planBefore);
    expect(readFileSync(join(flowDir(id), "plan-replies.md"), "utf8")).toBe("## 整體\n上一輪的舊回應\n");
  });

  it("仲裁輸出格式錯誤時重試仲裁，不暫停、不重跑索引與群，無效檔案移到 run 目錄", async () => {
    const id = "f-plan-layers-arbiter-invalid";
    await layeredRun(id, `if (kind === "arbiter" && !existsSync(".flow/arbiter-failed")) {
  writeFileSync(".flow/arbiter-failed", "");
  writeFileSync(".flow/plan-arbiter.json", JSON.stringify({ verdict: "changes_requested", items: [{ criterion: "範圍", status: "blocked", note: "x" }] }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${OBJECT}
}`, { agents: ["p1", "p2"] });
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), [
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="任務群" status="not_met">太大</issue>',
      '<issue criterion="需求覆蓋" status="not_met">缺逾時</issue>',
    ].join("\n"));
    const run = await planReviewRun(id, 6, ["p1", "p2"]);
    expect(seen(id)).toBe("index\ngroup\ngroup\narbiter\narbiter\narbiter\n");
    const retries = listRetries(id);
    expect(retries.find((item) => item.key === "plan-arbitration-run")?.category).toBe("format_invalid");
    expect(retries.some((item) => item.category === "arbitration_revise")).toBe(true);
    expect(run.attempts["plan-arbitration-run"]).toBeUndefined();
    expect(readdirSync(join(root, ".agentflowctl", "runs", id, "reviews")).some((f) => /^plan-arbiter-1-p\d-invalid\.json$/.test(f))).toBe(true);
    expect(run.stage).toBe("failed");
    expect(run.failedStage).toBe("plan_fix");
  });

  it("仲裁者沒寫出裁決檔時重試仲裁，並在 feedback.md 告訴下一次原因", async () => {
    const id = "f-plan-full-arbiter-missing";
    await layeredRun(id, `if (kind === "arbiter" && !existsSync(".flow/arbiter-failed")) {
  writeFileSync(".flow/arbiter-failed", "");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
if (kind === "arbiter" && existsSync(".flow/feedback.md")) appendFileSync(".flow/arbiter-feedback.txt", readFileSync(".flow/feedback.md", "utf8"));
${OBJECT}
}`, { agents: ["p1", "p2"], layers: { enabled: false } });
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), '<issue criterion="任務群" status="not_met">太大</issue>');
    const run = await planReviewRun(id, 4, ["p1", "p2"]);
    expect(run.stage).not.toBe("paused");
    expect(seen(id)).toBe("other\narbiter\narbiter\narbiter\n");
    expect(readFileSync(join(flowDir(id), "arbiter-feedback.txt"), "utf8")).toContain("plan-arbiter.json");
    expect(listRetries(id).find((item) => item.key === "plan-arbitration-run")?.category).toBe("format_invalid");
  });

  it("仲裁者額度用完而暫停時，resume 直接回到仲裁，不重跑整份審查", async () => {
    const id = "f-plan-full-arbiter-quota";
    await layeredRun(id, `if (kind === "arbiter" && !existsSync(".flow/arbiter-quota")) {
  writeFileSync(".flow/arbiter-quota", "");
  console.error("usage limit reached");
  process.exit(1);
}
${OBJECT}`, { agents: ["p1", "p2"], layers: { enabled: false } });
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), '<issue criterion="任務群" status="not_met">太大</issue>');
    const paused = await planReviewRun(id, 10, ["p1", "p2"]);
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("plan_review");
    expect(seen(id)).toBe("other\narbiter\n");
    resetSeen(id);
    resetQuotaState(); // resume 是新的程序，額度紀錄不會留著
    const run = await advance({ ...paused, stage: paused.pausedStage!, pausedStage: undefined, pauseReason: undefined, maxAgentRuns: 4 });
    expect(seen(id)).toBe("arbiter\narbiter\n");
    expect(run.failedStage).toBe("plan_fix");
  });

  it("仲裁暫停期間關掉 planArbiter 時，resume 不再進仲裁，改回重新審查", async () => {
    const id = "f-plan-arbiter-disabled-on-resume";
    await layeredRun(id, `if (kind === "arbiter") {
  console.error("usage limit reached");
  process.exit(1);
}
${OBJECT}`, { agents: ["p1", "p2"], layers: { enabled: false } });
    writeFileSync(join(flowDir(id), "plan-review-last.txt"), '<issue criterion="任務群" status="not_met">太大</issue>');
    const paused = await planReviewRun(id, 10, ["p1", "p2"]);
    expect(paused.stage).toBe("paused");
    expect(seen(id)).toBe("other\narbiter\n");
    const configPath = join(root, "flow.config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), planArbiter: false }));
    resetSeen(id);
    resetQuotaState();
    await advance({ ...paused, stage: paused.pausedStage!, pausedStage: undefined, pauseReason: undefined, maxAgentRuns: 3 });
    expect(seen(id)).toBe("other\n");
    expect(existsSync(join(flowDir(id), "dispute.md"))).toBe(false);
  });

  it("任務群審查失敗的升級計數以群 id 區分", async () => {
    const id = "f-plan-layers-group-key";
    await layeredRun(id, `if (kind === "group" && prompt.includes("任務群 G-2")) {
  writeFileSync(file, "{");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    const run = await planReviewRun(id, 3);
    const keys = Object.keys(run.modelRetryAttempts ?? {});
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^plan-review-group:G-2:p\d$/);
  });

  it("同一輪重跑時，沿用的索引呼叫不會再次套用它的交接事項", async () => {
    const id = "f-plan-layers-reuse-handoff";
    await layeredRun(id, `if (kind === "index") {
  writeFileSync(file, JSON.stringify({ verdict: "changes_requested", items: [{ criterion: "需求覆蓋", status: "not_met", note: "缺逾時" }] }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [{ kind: "action", summary: "補逾時", evidence: "需求第 1 句", targetStage: "plan" }], dispositions: [] }));
} else if (kind === "group" && prompt.includes("任務群 G-1") && !existsSync(".flow/g1-failed")) {
  writeFileSync(".flow/g1-failed", "");
  writeFileSync(file, "{");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    await planReviewRun(id, 4);
    expect(seen(id)).toBe("index\ngroup\ngroup\ngroup\n");
    expect(readHandoff(id).issues.filter((issue) => issue.summary === "補逾時")).toHaveLength(1);
  });
});
