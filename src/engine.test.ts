import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowRun } from "./schemas.js";

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
writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
  agents: { a: { adapter: "command", command: ["node", script] }, b: { adapter: "command", command: ["node", script] } },
  cycle: ["a", "b"],
}));

const { addWorktree, commitAll, git } = await import("./git.js");
const { advance, canReplan, iterateRun, replanRun, resetQuotaState, runChecks, withFiles } = await import("./engine.js");
const { mergeHandoff, readHandoff } = await import("./handoff.js");
const { confirmationsPath, flowDir, logDir, planReviewStatePath, runDir, worktreeDir } = await import("./paths.js");
const { addRetry, agentRuns, getRun, listRetries, listSubstitutions, listUsage, saveRun } = await import("./store.js");

// 會連續啟動多個 node 子程序的測試，本機約 2 到 3 秒；CI 的 macOS 較慢，預設 5 秒不夠
const SLOW_TEST_MS = 30_000;

// 額度用完的 agent 記在 engine 模組層，同一個測試程序內不會自動清掉；每個測試都從沒有人額度用完開始
beforeEach(() => resetQuotaState());

async function reviewRun(id: string, mode: "open" | "close", quorum = 1, tamper = false, adaptive = false, stopAfter?: "review" | "pr") {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
    taskIndex: 1, taskPhase: "tests" as const, stopAfter, createdAt: now, updatedAt: now,
  });
}

describe("審查交接關卡", () => {
  it("完成 review 停點後暫停，resume stage 指向 pr", async () => {
    const run = await reviewRun("f-stop-review", "close", 1, false, false, "review");
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("pr");
    expect(run.pauseReason).toContain("review");
  });

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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
const noopFile = \`.flow/noop-\${phase}.txt\`;
const noop = (phase === "direct" || phase === "tests") && existsSync(noopFile);
if (noop) rmSync(noopFile);
else if (phase === "tests") writeFileSync("feature.test.mjs", 'import { answer } from "./feature.mjs";\\nif (answer !== 42) process.exit(1);\\n');
else writeFileSync("feature.mjs", "export const answer = 42;\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function implementRun(
  id: string,
  acceptance: unknown,
  { maxAgentRuns = 2, tamper, tdd, test = "node feature.test.mjs", description = "匯出 answer", noop, kind }: { maxAgentRuns?: number; tamper?: "tests" | "code"; tdd?: boolean; test?: string | null; description?: string; noop?: boolean; kind?: "confirm" } = {},
) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
    cycle: ["a", "b"], install: "true", ...(test === null ? {} : { test }), checks: [],
  }));
  const wt = worktreeDir(id);
  await addWorktree(root, wt, "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "回傳答案", description, dependsOn: [], acceptance: ["AC-2"], ...(tdd === undefined ? {} : { tdd }), ...(kind ? { kind } : {}) },
  ]));
  if (noop) writeFileSync(join(flowDir(id), "noop-direct.txt"), "");
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

const greenScript = join(root, "green-implementer.mjs");
writeFileSync(greenScript, `import { existsSync, writeFileSync } from "node:fs";
if (existsSync(".flow/writes-code.txt")) writeFileSync("stub.mjs", \`export const n = \${Date.now()};\\n\`);
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

/** 綠燈階段：測試 commit 已經存在而且永遠失敗（測試本身寫錯），實作者無論怎麼做都不會綠 */
async function greenRun(id: string, { writesCode = false, attempts = {}, testsRedos, testSource = "process.exit(1);\n" }: { writesCode?: boolean; attempts?: Record<string, number>; testsRedos?: number; testSource?: string } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", greenScript] }])),
    cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
  }));
  const wt = worktreeDir(id);
  await addWorktree(root, wt, "main", `flow/${id}`);
  const taskBase = await git(wt, "rev-parse", "HEAD");
  writeFileSync(join(wt, "feature.test.mjs"), testSource);
  const testsCommit = (await commitAll(wt, "test(T-1): 測試 [a]"))!;
  mkdirSync(flowDir(id), { recursive: true });
  if (writesCode) writeFileSync(join(flowDir(id), "writes-code.txt"), "");
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-2", description: "匯出 answer" }]));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "元件", description: "新增元件", dependsOn: [], acceptance: ["AC-2"], tdd: true },
  ]));
  const now = new Date().toISOString();
  const run = await advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"], attempts, taskIndex: 0, taskPhase: "code",
    taskBase, testsCommit, lastTestsAuthor: "a", ...(testsRedos === undefined ? {} : { testsRedos }), createdAt: now, updatedAt: now,
  });
  return { run, wt, taskBase, testsCommit };
}

describe("紅燈階段檢查測試用到的套件匯出", () => {
  it("測試呼叫了已安裝套件沒有的匯出：直接退回測試作者，不進入綠燈", async () => {
    const id = "f-red-missing-export";
    mkdirSync(join(root, "node_modules", "old-lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", "old-lib", "package.json"), JSON.stringify({ name: "old-lib", main: "index.js" }));
    writeFileSync(join(root, "node_modules", "old-lib", "index.js"), "exports.render = () => 1;\n");
    const script = join(root, "missing-export-tests.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs";
writeFileSync("feature.test.mjs", "// import { renderHook } from 'old-lib'\\nrenderHook();\\nprocess.exit(1);\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    const taskBase = await git(wt, "rev-parse", "HEAD");
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-2", description: "匯出 answer" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件", description: "新增元件", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.taskPhase).toBe("tests");
    expect(run.attempts["T-1:tests"]).toBe(1);
    expect(await git(wt, "rev-parse", "HEAD")).toBe(taskBase);
    expect(readFileSync(join(flowDir(id), "feedback.md"), "utf8")).toContain("renderHook（來自 old-lib）");
    expect(listRetries(id).map((item) => item.category)).toEqual(["tests_invalid"]);
  });
});

describe("紅燈階段：失敗的不是本任務的測試", () => {
  it("全套測試失敗的是別的測試檔（分支上早就壞了）：還原測試 commit 並暫停，不進入綠燈", async () => {
    const id = "f-red-foreign-failure";
    const script = join(root, "foreign-failure-tests.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs";
writeFileSync("feature.test.mjs", "// 新測試\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["a", "b"], install: "true", checks: [],
      test: "node -e \"console.log(' FAIL  src/pages/b/Card.reason.test.tsx > 優先序'); process.exit(1)\"",
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    const taskBase = await git(wt, "rev-parse", "HEAD");
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-2", description: "匯出 answer" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件", description: "新增元件", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 5, cycle: ["a", "b"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.stage).toBe("paused");
    expect(run.pauseReason).toContain("Card.reason.test.tsx");
    expect(run.pauseReason).toContain("resume");
    expect(run.taskPhase).toBe("tests");
    expect(await git(wt, "rev-parse", "HEAD")).toBe(taskBase);
    expect(listRetries(id)).toEqual([]);
  });
});

describe("綠燈階段無法讓測試通過時退回測試階段", () => {
  it("實作者沒有任何變更、測試仍未通過：丟掉這輪，退回重寫測試，並把原因與舊測試 commit 交給測試作者", async () => {
    // maxAgentRuns 為 1：退回後下一步會因額度用完而停下，所以只檢查退回的結果，不看 stage
    const { run, wt, taskBase, testsCommit } = await greenRun("f-green-no-progress");
    expect(run.taskPhase).toBe("tests");
    expect(run.testsCommit).toBeUndefined();
    expect(run.testsRedos).toBe(1);
    expect(run.attempts["T-1:code"]).toBeUndefined();
    expect(await git(wt, "rev-parse", "HEAD")).toBe(taskBase);
    const feedback = readFileSync(join(flowDir(run.id), "feedback.md"), "utf8");
    expect(feedback).toContain(testsCommit);
    expect(feedback).toContain("測試本身");
    expect(listRetries(run.id).map((item) => item.category)).toEqual(["tests_invalid"]);
  });

  it("實作者有改程式但連續兩次都不通過：同樣退回測試階段", async () => {
    const { run } = await greenRun("f-green-repeated", { writesCode: true, attempts: { "T-1:code": 1 } });
    expect(run.taskPhase).toBe("tests");
    expect(run.testsRedos).toBe(1);
    expect(listRetries(run.id).map((item) => item.category)).toEqual(["tests_invalid"]);
  });

  it("第一次失敗就是測試呼叫了套件沒有的匯出：不等第二次，立刻退回", async () => {
    const { run } = await greenRun("f-green-broken-import", {
      writesCode: true,
      testSource: "// import { renderHook } from 'some-pkg'\nconsole.log('TypeError: renderHook is not a function');\nprocess.exit(1);\n",
    });
    expect(run.taskPhase).toBe("tests");
    expect(run.testsRedos).toBe(1);
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toContain("renderHook");
    expect(listRetries(run.id).map((item) => item.category)).toEqual(["tests_invalid"]);
  });

  it("第一次失敗而且有改程式：照舊在綠燈階段重試，不退回", async () => {
    const { run } = await greenRun("f-green-first-failure", { writesCode: true });
    expect(run.taskPhase).toBe("code");
    expect(run.attempts["T-1:code"]).toBe(1);
    expect(listRetries(run.id).map((item) => item.category)).toEqual(["tests_not_green"]);
  });

  it("同一個任務已退回測試階段達上限仍過不了：暫停等人處理，狀態回到測試階段並讓 resume 再有退回機會", async () => {
    const { run, wt, taskBase } = await greenRun("f-green-redo-limit", { testsRedos: 2 });
    expect(run.stage).toBe("paused");
    expect(run.pauseReason).toContain("resume");
    expect(run.taskPhase).toBe("tests");
    expect(run.testsCommit).toBeUndefined();
    expect(run.testsRedos).toBeUndefined();
    expect(await git(wt, "rev-parse", "HEAD")).toBe(taskBase);
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toContain("測試本身");
  });
});

describe("重試前短發散", () => {
  const divergeScript = join(root, "diverge-implementer.mjs");
  writeFileSync(divergeScript, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
if (prompt.includes("發散分支")) {
  const frame = /<frame>\\n(\\w+)/.exec(prompt)[1];
  writeFileSync(".flow/diverge-branch.json", JSON.stringify({ frame, hypothesis: "h-" + frame, nextStep: "n-" + frame }));
} else if (prompt.includes("發散評審")) {
  writeFileSync(".flow/diverge-pick.json", JSON.stringify({
    pick: /"frame": "(\\w+)"/.exec(prompt)[1], action: "keep_fixing", rationale: "對上驗收", nextStep: "先改斷言再實作",
  }));
} else {
  const fb = existsSync(".flow/feedback.md") ? readFileSync(".flow/feedback.md", "utf8") : "";
  writeFileSync(".flow/saw-diverge.txt", fb);
  if (prompt.includes("<red_output>")) writeFileSync("stub.mjs", "export const n = 1;\\n");
  else writeFileSync("feature.test.mjs", "process.exit(1);\\n");
}
`);

  async function setup(id: string, extra: Record<string, unknown> = {}) {
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", divergeScript] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
      diverge: { enabled: true, after: 2, branches: 2 },
      ...extra,
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    const taskBase = await git(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "feature.test.mjs"), "process.exit(1);\n");
    const testsCommit = (await commitAll(wt, "test(T-1): 測試 [a]"))!;
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-2", description: "匯出 answer" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件", description: "新增元件", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    writeFileSync(join(flowDir(id), "red-output.txt"), "FAIL");
    return { taskBase, testsCommit, now: new Date().toISOString() };
  }

  const base = (id: string, o: { now: string; taskBase: string; testsCommit: string }) => ({
    id, baseBranch: "main" as const, branch: `flow/${id}`, requirement: "測試功能", stage: "implement" as const,
    autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"] as string[], attempts: {},
    taskIndex: 0, taskBase: o.taskBase, testsCommit: o.testsCommit, createdAt: o.now,
    // 真實流程是先記 retry、再存 state，所以 updatedAt 不會早於已有的 retry；否則 addRetry 會把同 key、同 attempt 的紀錄當成重複
    updatedAt: new Date().toISOString(),
  });
  /** failed（預算用完）的 run 再給 calls 次 agent 呼叫的額度：額度逐次呼叫把關，一個階段有幾次呼叫就要給幾次 */
  const oneMoreStep = (run: FlowRun, calls = 1) => ({
    ...run, stage: "implement" as const, failedStage: undefined, failureCategory: undefined, failureReason: undefined,
    maxAgentRuns: agentRuns(run.id) + calls,
  });

  it("綠燈第二次失敗退回測試後，下一次寫測試前才發散；回到 code 階段不會再發散", async () => {
    const id = "f-diverge-redo";
    const o = await setup(id);
    // 真實序列：第一次綠燈失敗已經留下一筆 tests_not_green，這次是第二次，所以走 redoTests
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_not_green", attempt: 1, final: false });
    const first = await advance({ ...base(id, o), taskPhase: "code", attempts: { "T-1:code": 1 }, lastTestsAuthor: "a" });
    expect(first.taskPhase).toBe("tests");
    expect(first.testsRedos).toBe(1);
    expect(existsSync(join(runDir(id), "diverge.json"))).toBe(false);
    expect(agentRuns(id)).toBe(1);

    // 下一個階段：2 個分支 + 1 個評審 + 1 次寫測試
    const second = await advance(oneMoreStep(first, 4));
        const record = JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8"));
    expect(record.status).toBe("done");
    expect(record.stamp).toBe("T-1:tests:0:1");
    expect(record.retriesSeen).toBe(2);
    expect(record.frames).toContain(record.pick.pick);
    expect(second.taskPhase).toBe("code");
    expect(agentRuns(id)).toBe(1 + 4);
    // 發散後的測試作者讀得到結論（之後 retry() 會覆寫 feedback.md，所以由腳本留證據）
    expect(readFileSync(join(flowDir(id), "saw-diverge.txt"), "utf8")).toContain("先改斷言再實作");

    // 回到 code 階段：T-1:code 仍有 tests_not_green + tests_invalid 兩筆，但都在 retriesSeen 之前，不能再發散
    const third = await advance(oneMoreStep(second));
    expect(agentRuns(id)).toBe(1 + 4 + 1);
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).stamp).toBe("T-1:tests:0:1");
    expect(third.stage).not.toBe("paused");
  });

  it("已有相同 stamp 且 done 時不重跑發散", async () => {
    const id = "f-diverge-resume";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(join(runDir(id), "diverge.json"), JSON.stringify({
      stamp: "T-1:tests:0:1", status: "done", key: "T-1:tests", frames: ["acceptance", "split"], retriesSeen: 1,
      branches: [], pick: { pick: "split", action: "split_task", rationale: "已做過", nextStep: "拆任務" },
    }));
    await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).pick.nextStep).toBe("拆任務");
    expect(agentRuns(id)).toBe(1); // 只有寫測試那一次
  });

  it("stamp 還是 running（中斷或評審額度暫停）時 resume 會重跑", async () => {
    const id = "f-diverge-running";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(join(runDir(id), "diverge.json"), JSON.stringify({
      stamp: "T-1:tests:0:1", status: "running", key: "T-1:tests", frames: ["acceptance", "split"], branches: [],
    }));
    await advance({ ...base(id, o), maxAgentRuns: 4, taskPhase: "tests", testsRedos: 1 });
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).status).toBe("done");
    expect(agentRuns(id)).toBe(4);
  });

  it("分支把 .flow/feedback.md 改掉、或留下 commit，評審與後續寫檔都看不到", async () => {
    const id = "f-diverge-isolation";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    writeFileSync(join(flowDir(id), "feedback.md"), "原本的回饋\n");
    const tamper = join(root, "diverge-tamper.mjs");
    writeFileSync(tamper, `import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const prompt = readFileSync(0, "utf8");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
if (prompt.includes("發散分支")) {
  const frame = /<frame>\\n(\\w+)/.exec(prompt)[1];
  writeFileSync(".flow/feedback.md", "被分支改掉");
  writeFileSync("leak.txt", "x");
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "leak"]);
  writeFileSync(".flow/diverge-branch.json", JSON.stringify({ frame, hypothesis: "h", nextStep: "n" }));
} else if (prompt.includes("發散評審")) {
  writeFileSync(".flow/diverge-pick.json", JSON.stringify({ pick: /"frame": "(\\w+)"/.exec(prompt)[1], action: "keep_fixing", rationale: "r", nextStep: "n" }));
} else {
  writeFileSync("feature.test.mjs", "process.exit(1);\\n");
}
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", tamper] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [], diverge: { enabled: true, after: 2, branches: 2 },
    }));
    const run = await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(existsSync(join(worktreeDir(id), "leak.txt"))).toBe(false);
    expect(await git(worktreeDir(id), "log", "--format=%s", "-1")).not.toBe("leak");
    expect(run.stage).not.toBe("paused");
    // 發散結論是追加在還原後的 feedback 之後
    expect(readFileSync(join(flowDir(id), "feedback.md"), "utf8")).not.toContain("被分支改掉");
  });

  it("關閉時完全不發散", async () => {
    const id = "f-diverge-off";
    const o = await setup(id, { diverge: { enabled: false } });
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(existsSync(join(runDir(id), "diverge.json"))).toBe(false);
    expect(agentRuns(id)).toBe(1);
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

  it("描述寫明不要求紅燈時仍撰寫測試，一開始就通過也進入綠燈", async () => {
    const id = "f-waive-red-writes-tests";
    const acceptance = [{ id: "AC-2", description: "匯出 answer 為 42" }];
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    writeFileSync(join(wt, "feature.mjs"), "export const answer = 42;\n");
    await commitAll(wt, "feat: 既有實作");
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(join(flowDir(id), "feedback.md"), "測試在功能尚未實作前就全部通過。請撰寫會因功能尚未實作而失敗的測試。\n");
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "特徵化", description: "特徵化測試，不要求紅燈", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.taskPhase).toBe("code");
    expect(run.failureReason ?? "").not.toMatch(/tdd 不是 false/);
    expect(agentRuns(id)).toBe(1);
    expect(existsSync(join(wt, "feature.test.mjs"))).toBe(true);
    expect(listRetries(id).map((item) => item.category)).not.toContain("tests_not_red");
    const prompt = readFileSync(join(flowDir(id), "prompt-tests.txt"), "utf8");
    expect(prompt).toContain("一開始就通過");
    expect(prompt).not.toContain("因為功能尚未實作而**失敗**");
    expect(existsSync(join(flowDir(id), "feedback-tests.txt"))).toBe(false);
  });

  it("實作早已存在、上一次剛因測試一開始就通過被退回時，改接受特徵化測試而不是重試到上限", async () => {
    const id = "f-red-already-green";
    const acceptance = [{ id: "AC-2", description: "匯出 answer 為 42" }];
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    writeFileSync(join(wt, "feature.mjs"), "export const answer = 42;\n");
    await commitAll(wt, "feat: 前一個任務順手做掉的實作");
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件測試", description: "新增元件測試", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    const base = {
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement" as const,
      autopilot: true, maxAgentRuns: 2, cycle: ["a", "b"], taskIndex: 0, taskPhase: "tests" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    // 第一次：照常要求紅燈，退回重試
    const first = await advance({ ...base, maxAgentRuns: 1, attempts: {} });
    expect(first.attempts["T-1:tests"]).toBe(1);
    expect(listRetries(id).map((item) => item.category)).toContain("tests_not_red");
    expect(readFileSync(join(flowDir(id), "feedback.md"), "utf8")).toContain("請撰寫會因功能尚未實作而失敗的測試");
    // 第二次：行為早已存在，改接受特徵化測試，進入綠燈
    const second = await advance({ ...first, stage: "implement", maxAgentRuns: 2 });
    expect(second.taskPhase).toBe("code");
    expect(second.attempts["T-1:tests"]).toBeUndefined();
    expect(listRetries(id)).toHaveLength(1);
    expect(readFileSync(join(flowDir(id), "red-output.txt"), "utf8")).toContain("不要求紅燈");
  });

  it("測試階段沒有新增任何檔案、但現有測試已通過時，視為已涵蓋並進入綠燈", async () => {
    const id = "f-tests-covered";
    const acceptance = [{ id: "AC-2", description: "匯出 answer 為 42" }];
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
      cycle: ["a", "b"], install: "true", test: "true", checks: [],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "noop-tests.txt"), "");
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件測試", description: "新增元件測試", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run.taskPhase).toBe("code");
    expect(listRetries(id).map((item) => item.category)).not.toContain("tests_not_written");
    expect(readFileSync(join(flowDir(id), "red-output.txt"), "utf8")).toContain("視為已涵蓋");
  });

  it("實作階段動到後面任務負責的檔案時還原並重試", async () => {
    const id = "f-out-of-scope";
    const acceptance = [{ id: "AC-2", description: "匯出 answer 為 42" }, { id: "AC-3", description: "後面任務" }];
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [], taskConcurrency: 1,
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(acceptance));
    // T-2 的描述把 feature.mjs 派給它，但實作者在 T-1 就會寫 feature.mjs
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "第一個", description: "新增 ./feature.test.mjs", dependsOn: [], acceptance: ["AC-2"], tdd: true },
      { id: "T-2", title: "第二個", description: "實作 ./feature.mjs", dependsOn: [], acceptance: ["AC-3"], tdd: true },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 2, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(listRetries(id).map((item) => item.category)).toContain("out_of_scope");
    expect(existsSync(join(wt, "feature.mjs"))).toBe(false);
    expect(run.attempts["T-1:code"]).toBe(1);
  });

  it("不走 TDD 且沒有檔案變更時略過任務，不以未實作重試", async () => {
    const run = await implementRun("f-no-commit-skip", acceptance, { maxAgentRuns: 1, tdd: false, noop: true });
    expect(run.failureCategory).toBe("agent_budget");
    expect(run.taskIndex).toBe(1);
    expect(agentRuns(run.id)).toBe(1);
    expect(listRetries(run.id).map((item) => item.category)).not.toContain("code_not_written");
    expect(existsSync(join(worktreeDir(run.id), "feature.mjs"))).toBe(false);
  });

  it("kind 為 confirm 時從實作清單拿掉、另存給使用者，不停下", async () => {
    const run = await implementRun("f-confirm-task", acceptance, { maxAgentRuns: 1, kind: "confirm" });
    expect(run.stage).not.toBe("awaiting_approval");
    expect(run.failedStage).toBe("review");
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "tasks.ordered.json"), "utf8"))).toEqual([]);
    const confirm = JSON.parse(readFileSync(confirmationsPath(run.id), "utf8"));
    expect(confirm.map((t: { id: string }) => t.id)).toEqual(["T-1"]);
    expect(agentRuns(run.id)).toBe(1);
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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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

  it("任務修正動到後面任務負責的檔案時還原並帶著原本的意見重試", async () => {
    const id = "f-fix-out-of-scope";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", fixer] }])),
      cycle: ["a", "b"], install: "true", test: "true", checks: [],
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "a" }, { id: "AC-2", description: "b" }]));
    writeFileSync(join(flowDir(id), "feedback.md"), "型別檢查失敗");
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "第一個", description: "新增 ./first.txt", dependsOn: [], acceptance: ["AC-1"], tdd: false },
      { id: "T-2", title: "第二個", description: "新增 ./fixed.txt", dependsOn: [], acceptance: ["AC-2"], tdd: false },
    ]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement", fixSource: "verify",
      autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"], lastWriter: "a", attempts: {},
      taskIndex: 0, taskPhase: "fix", createdAt: now, updatedAt: now,
    });
    expect(run.attempts["T-1:fix"]).toBe(1);
    expect(listRetries(id).map((item) => item.category)).toContain("out_of_scope");
    expect(existsSync(join(worktreeDir(id), "fixed.txt"))).toBe(false);
    const feedback = readFileSync(join(flowDir(id), "feedback.md"), "utf8");
    expect(feedback).toContain("型別檢查失敗");
    expect(feedback).toContain("fixed.txt（T-2）");
  });
});

const repairScript = join(root, "repair.mjs");
writeFileSync(repairScript, `import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const behavior = existsSync(".flow/repair-mode.txt") ? readFileSync(".flow/repair-mode.txt", "utf8").trim() : "repair-ok";
const repairing = prompt.includes("交接紀錄員");
const phase = repairing ? "repair" : prompt.includes("需求分析師") ? "spec" : prompt.includes("<red_output>") ? "code" : prompt.includes("你是除錯工程師") ? "fix" : "tests";
appendFileSync(".flow/calls.txt", phase + "\\n");
if (repairing) {
  if (behavior !== "repair-bad") writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
  if (behavior === "repair-tamper" || behavior === "repair-commit") writeFileSync("evil.ts", "export {};\\n");
  if (behavior === "repair-commit") execSync("git add -A && git -c user.name=t -c user.email=t@t commit -qm evil");
  if (behavior === "repair-plan-tamper") writeFileSync(".flow/spec.md", "被補寫改掉");
  process.exit(0);
}
if (phase === "spec") {
  writeFileSync(".flow/spec.md", "# 規格\\n");
  writeFileSync(".flow/acceptance.json", JSON.stringify([{ id: "AC-1", description: "匯出 answer 為 42" }]));
  writeFileSync(".flow/handoff-response.json", "{ 壞掉的 json");
  process.exit(0);
}
if (phase === "fix") writeFileSync("fixed.ts", "export const fixed = true;\\n");
if (phase === "tests") writeFileSync("feature.test.mjs", 'import { answer } from "./feature.mjs";\\nif (answer !== 42) process.exit(1);\\n');
if (phase === "code") writeFileSync("feature.mjs", "export const answer = 42;\\n");
writeFileSync(".flow/handoff-response.json", "{ 壞掉的 json");
`);

describe("交接補寫", () => {
  const calls = (id: string) => readFileSync(join(flowDir(id), "calls.txt"), "utf8");

  async function fixRun(id: string, mode: string) {
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", repairScript] }])),
      cycle: ["a", "b"], install: "true", test: "true", checks: [],
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "repair-mode.txt"), mode);
    writeFileSync(join(flowDir(id), "feedback.md"), "檢查失敗");
    const now = new Date().toISOString();
    // fix 與補寫共用 2 次 agent 預算，下一次迴圈開頭就以 agent_budget 失敗，failedStage 是 fix 之後要進的階段
    return advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "fix", fixSource: "verify",
      autopilot: true, maxAgentRuns: 2, cycle: ["a", "b"], lastWriter: "a", attempts: {},
      taskIndex: 1, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
  }

  it("fix 的交接不合格時只補寫交接，保留修正的 commit", async () => {
    const run = await fixRun("f-repair-ok", "repair-ok");
    expect(run).toMatchObject({ stage: "failed", failedStage: "verify", failureCategory: "agent_budget" });
    expect(listRetries(run.id).some((r) => r.category === "handoff_invalid")).toBe(false);
    expect(calls(run.id)).toBe("fix\nrepair\n");
    expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
  });

  it("補寫後仍不合格時還原修正並照舊重試", async () => {
    const run = await fixRun("f-repair-bad", "repair-bad");
    expect(run).toMatchObject({ stage: "failed", failedStage: "fix", failureCategory: "agent_budget" });
    expect(listRetries(run.id).map((r) => r.category)).toContain("handoff_invalid");
    expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(false);
  });

  it("補寫呼叫動到其他檔案時會被還原", async () => {
    const run = await fixRun("f-repair-tamper", "repair-tamper");
    expect(run).toMatchObject({ failedStage: "verify" });
    expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
    expect(existsSync(join(worktreeDir(run.id), "evil.ts"))).toBe(false);
  });

  it("補寫呼叫自行 commit 時也會被丟棄", async () => {
    const run = await fixRun("f-repair-commit", "repair-commit");
    expect(run).toMatchObject({ failedStage: "verify" });
    expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
    expect(existsSync(join(worktreeDir(run.id), "evil.ts"))).toBe(false);
    expect(await git(worktreeDir(run.id), "log", "--format=%s")).not.toContain("evil");
  });

  it("規格的交接不合格時只補寫交接，補寫動到規格會被還原", async () => {
    const id = "f-repair-spec";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", repairScript] }])),
      cycle: ["a", "b"], install: "true", test: "true", checks: [],
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "repair-mode.txt"), "repair-plan-tamper");
    const now = new Date().toISOString();
    // 規格與補寫共 2 次 agent，之後在計畫階段前達到上限
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "spec",
      autopilot: true, maxAgentRuns: 2, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run).toMatchObject({ failedStage: "plan", failureCategory: "agent_budget" });
    expect(listRetries(id).some((r) => r.category === "handoff_invalid")).toBe(false);
    expect(calls(id)).toBe("spec\nrepair\n");
    expect(readFileSync(join(flowDir(id), "spec.md"), "utf8")).toBe("# 規格\n");
  });

  it("紅燈測試與綠燈實作的交接不合格時也只補寫交接", async () => {
    const id = "f-repair-tdd";
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", repairScript] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "匯出 answer 為 42" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "回傳答案", description: "匯出 answer", dependsOn: [], acceptance: ["AC-1"] },
    ]));
    const now = new Date().toISOString();
    // 紅燈、綠燈各含一次補寫共 4 次 agent，之後在任務審查前達到上限
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
      autopilot: true, maxAgentRuns: 4, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(run).toMatchObject({ failedStage: "implement", failureCategory: "agent_budget", taskPhase: "review" });
    expect(run.testsCommit).toBeTruthy();
    expect(listRetries(id).some((r) => r.category === "handoff_invalid")).toBe(false);
    expect(calls(id)).toBe("tests\nrepair\ncode\nrepair\n");
  });
});

const worker = join(root, "worker.mjs");
writeFileSync(worker, `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
// 審查者在臨時 worktree 執行、.flow/ 是複本；要讓測試看得到的副作用得寫回 run 自己的 worktree（絕對路徑）
const tempRun = process.cwd().match(/runs\\/([^/]+)\\/tmp-review/)?.[1];
const shared = tempRun ? ${JSON.stringify(root)} + "/.agentflowctl/worktrees/" + tempRun + "/.flow" : ".flow";
const id = prompt.match(/"id": "(T-\\d+)"/)?.[1];
const role = prompt.includes("你是任務審查者") ? "task-review" : prompt.includes("你是程式碼審查者") ? "review"
  : prompt.includes("你是除錯工程師") ? "fix" : prompt.includes("<red_output>") ? "code" : "tests";
appendFileSync(shared + "/steps.txt", \`\${role}\${role === "review" || role === "fix" ? "" : ":" + id}\\n\`);
if (role === "task-review" && existsSync(shared + "/fail-review-once.txt")) {
  rmSync(shared + "/fail-review-once.txt");
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
  writeFileSync(\`\${shared}/diff-\${role}-\${id ?? "all"}.txt\`, readFileSync(".flow/diff.patch"));
  const reject = role === "task-review" && existsSync(shared + "/reject-once.txt");
  if (reject) rmSync(shared + "/reject-once.txt");
  writeFileSync(".flow/review.json", JSON.stringify(reject
    ? { verdict: "changes_requested", items: [{ criterion: "AC-1", status: "partial", note: "缺少邊界情況" }] }
    : { verdict: "approve", items: [] }));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function taskFlowRun(id: string, { tasks = 1, check = "true", rejectOnce = false,
  failReviewOnce = false, failFixOnce = false, stopAfter }: { tasks?: number; check?: string; rejectOnce?: boolean;
  failReviewOnce?: boolean; failFixOnce?: boolean; stopAfter?: "spec" | "plan" | "implement" | "verify" | "review" | "pr" } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", worker] }])),
    cycle: ["a", "b"], install: "true", taskConcurrency: 1, test: "for f in T-*.test.mjs; do node $f || exit 1; done",
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
    taskIndex: 0, taskPhase: "tests", stopAfter, createdAt: now, updatedAt: now,
  });
}

const steps = (id: string) => readFileSync(join(flowDir(id), "steps.txt"), "utf8").trim().split("\n");

// 平行任務：每個沒有相依關係的任務各在自己的 worktree 跑完整個任務流程，完成後合併回 run 的分支
const laneWorker = join(root, "lane-worker.mjs");
const laneLog = join(root, "lane-log.txt");
const laneBarrier = join(root, "lane-barrier");
writeFileSync(laneWorker, `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const id = prompt.match(/"id": "(T-\\d+)"/)?.[1];
const role = prompt.includes("你是任務審查者") ? "task-review" : prompt.includes("你是程式碼審查者") ? "review"
  : prompt.includes("你是除錯工程師") ? "fix" : prompt.includes("<red_output>") ? "code" : "tests";
const cfg = existsSync(${JSON.stringify(join(root, "lane-config.json"))}) ? JSON.parse(readFileSync(${JSON.stringify(join(root, "lane-config.json"))}, "utf8")) : {};
appendFileSync(${JSON.stringify(laneLog)}, role + ":" + id + "\\n");
if (role === "tests" && cfg.barrier?.includes(id)) {
  // 要同時跑的任務都開始了才繼續：依序執行的話會一直等到逾時而失敗
  mkdirSync(${JSON.stringify(laneBarrier)}, { recursive: true });
  writeFileSync(${JSON.stringify(laneBarrier)} + "/" + id, "");
  const t = Date.now();
  while (!cfg.barrier.every((x) => existsSync(${JSON.stringify(laneBarrier)} + "/" + x))) {
    if (Date.now() - t > 8000) process.exit(1);
  }
}
if (cfg.quota?.includes(id) && role === "tests") {
  console.error("You've hit your usage limit. Try again later.");
  process.exit(1);
}
if (cfg.alwaysFail?.includes(id) && (role === "tests" || role === "code")) process.exit(1);
if (role === "tests") {
  // exclusive：這幾個任務單獨都能過，合在一起才壞（沒有文字衝突的語意衝突）
  const others = (cfg.exclusive?.includes(id) ? cfg.exclusive.filter((x) => x !== id) : []).map((x) => "if (existsSync(\\"./" + x + ".mjs\\")) process.exit(1);\\n").join("");
  writeFileSync(id + ".test.mjs", "import { existsSync } from \\"node:fs\\";\\nimport { ok } from \\"./" + id + ".mjs\\";\\n" + others + "if (!ok) process.exit(1);\\n");
}
if (role === "code") {
  writeFileSync(id + ".mjs", "export const ok = true;\\n");
  if (cfg.shared?.includes(id)) appendFileSync("shared.txt", id + "\\n");
}
if (role === "task-review" || role === "review") writeFileSync(".flow/review.json", JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function laneFlowRun(id: string, deps: Record<string, string[]>, opts: { config?: object; maxAgentRuns?: number; taskConcurrency?: number; maxAttempts?: number } = {}) {
  rmSync(laneBarrier, { recursive: true, force: true });
  rmSync(laneLog, { force: true });
  writeFileSync(join(root, "lane-config.json"), JSON.stringify(opts.config ?? {}));
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", laneWorker] }])),
    cycle: ["a", "b"], install: "true", test: "for f in T-*.test.mjs; do node $f || exit 1; done",
    checks: [], ...(opts.taskConcurrency ? { taskConcurrency: opts.taskConcurrency } : {}),
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  const ids = Object.keys(deps);
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify(ids.map((t, i) => ({ id: `AC-${i + 1}`, description: `${t} 完成` }))));
  writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify(ids.map((t, i) => (
    { id: t, title: `任務 ${t}`, description: `完成 ${t}`, dependsOn: deps[t], acceptance: [`AC-${i + 1}`] }
  ))));
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns: opts.maxAgentRuns ?? 60, maxAttempts: opts.maxAttempts, cycle: ["a", "b"], attempts: {},
    taskIndex: 0, taskPhase: "tests", stopAfter: "implement", createdAt: now, updatedAt: now,
  });
}
const laneSteps = () => readFileSync(laneLog, "utf8").trim().split("\n");

describe("平行任務", () => {
  it("沒有相依的任務同時跑，合併後才解鎖下游，最後都在 run 的分支上", async () => {
    const id = "f-lanes";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [], "T-3": ["T-1", "T-2"] }, { config: { barrier: ["T-1", "T-2"] } });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("verify");
    expect([...(run.doneTasks ?? [])].sort()).toEqual(["T-1", "T-2", "T-3"]);
    expect(run.taskIndex).toBe(3);
    const wt = worktreeDir(id);
    for (const t of ["T-1", "T-2", "T-3"]) expect(existsSync(join(wt, `${t}.mjs`))).toBe(true);
    const log = await git(wt, "log", "--format=%s");
    expect(log).toContain("merge(T-1)");
    expect(log).toContain("merge(T-2)");
    // T-3 要等 T-1、T-2 都合併後才開始
    const steps = laneSteps();
    const firstT3 = steps.indexOf("tests:T-3");
    expect(steps.indexOf("code:T-1")).toBeLessThan(firstT3);
    expect(steps.indexOf("code:T-2")).toBeLessThan(firstT3);
    // 合併後車道的 worktree 與分支都清掉；node_modules 之類的東西不會被 commit
    expect(existsSync(worktreeDir(`${id}+T-1`))).toBe(false);
    expect((await git(root, "branch", "--list", `flow/${id}+*`))).toBe("");
    expect(agentRuns(id)).toBeGreaterThanOrEqual(9);
  });

  it("log 序號不重複，所有車道的 log 都記在 run 底下", async () => {
    const id = "f-lanes-logs";
    await laneFlowRun(id, { "T-1": [], "T-2": [] });
    const names = readdirSync(logDir(id));
    const seqs = names.map((n) => n.slice(0, 3));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(names.some((n) => n.includes("T-1-tests"))).toBe(true);
    expect(names.some((n) => n.includes("T-2-tests"))).toBe(true);
  });

  it("taskConcurrency 為 1 時一個一個做，不建立車道", async () => {
    const id = "f-lanes-off";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { taskConcurrency: 1 });
    expect(run.stage).toBe("paused");
    expect(run.doneTasks).toBeUndefined();
    expect(existsSync(join(runDir(id), "lanes"))).toBe(false);
    expect(laneSteps().filter((s) => s.startsWith("tests:"))).toEqual(["tests:T-1", "tests:T-2"]);
  });

  it("只有相依鏈時照舊一個一個做", async () => {
    const id = "f-lanes-chain";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": ["T-1"] });
    expect(run.stage).toBe("paused");
    expect(run.doneTasks).toBeUndefined();
    expect(existsSync(join(runDir(id), "lanes"))).toBe(false);
  });

  it("兩個任務改到同一個檔案而衝突時，後合併的從最新的分支重做", async () => {
    const id = "f-lanes-conflict";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { config: { barrier: ["T-1", "T-2"], shared: ["T-1", "T-2"] } });
    expect(run.failureReason).toBeUndefined();
    expect([...(run.doneTasks ?? [])].sort()).toEqual(["T-1", "T-2"]);
    expect(readFileSync(join(worktreeDir(id), "shared.txt"), "utf8").split("\n").filter(Boolean).sort()).toEqual(["T-1", "T-2"]);
    expect(listRetries(id).some((r) => r.category === "merge_conflict")).toBe(true);
  });

  it("合併後全套測試變紅（沒有文字衝突的語意衝突）：還原合併，後合併的車道從最新分支重做", async () => {
    const id = "f-lanes-semantic";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { config: { barrier: ["T-1", "T-2"], exclusive: ["T-1", "T-2"] }, maxAttempts: 3 });
    // 重做的車道在最新分支上同樣過不了（兩個任務互斥），最後失敗或暫停；重點是壞掉的合併沒有留在 run 的分支上
    expect(["failed", "paused"]).toContain(run.stage);
    expect(listRetries(id).some((r) => r.category === "merge_tests_failed")).toBe(true);
    expect(run.doneTasks).toHaveLength(1);
    const wt = worktreeDir(id);
    const mergedTask = run.doneTasks?.[0] ?? "";
    const other = mergedTask === "T-1" ? "T-2" : "T-1";
    expect(existsSync(join(wt, `${mergedTask}.mjs`))).toBe(true);
    expect(existsSync(join(wt, `${other}.mjs`))).toBe(false);
    expect(await git(wt, "status", "--porcelain")).toBe("");
  });

  it("有車道失敗時 run 失敗並指出是哪個任務，已完成的任務仍合併", async () => {
    const id = "f-lanes-fail";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { config: { alwaysFail: ["T-2"] }, maxAttempts: 3 });
    expect(run.stage).toBe("failed");
    expect(run.failureReason).toMatch(/^T-2：/);
    expect(run.failureCategory).toBe("retry_limit");
    expect(run.doneTasks).toEqual(["T-1"]);
    expect(existsSync(join(worktreeDir(id), "T-1.mjs"))).toBe(true);
  });

  it("失敗後 resume：失敗的車道從頭重來，已合併的任務不再重做", async () => {
    const id = "f-lanes-resume";
    const failed = await laneFlowRun(id, { "T-1": [], "T-2": [], "T-3": ["T-1", "T-2"] }, { config: { alwaysFail: ["T-2"] }, maxAttempts: 3 });
    expect(failed.stage).toBe("failed");
    writeFileSync(join(root, "lane-config.json"), JSON.stringify({}));
    rmSync(laneLog, { force: true });
    const resumed = await advance({ ...failed, stage: failed.failedStage!, attempts: {}, failedStage: undefined, failureReason: undefined, failureCategory: undefined });
    expect(resumed.failureReason).toBeUndefined();
    expect([...(resumed.doneTasks ?? [])].sort()).toEqual(["T-1", "T-2", "T-3"]);
    expect(laneSteps()).not.toContain("tests:T-1");
    for (const t of ["T-1", "T-2", "T-3"]) expect(existsSync(join(worktreeDir(id), `${t}.mjs`))).toBe(true);
  });

  it("有車道額度用完時 run 暫停，resume 後接續，已合併的任務不重做", async () => {
    const id = "f-lanes-quota";
    const paused = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { config: { quota: ["T-2"] } });
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("implement");
    expect(paused.pauseReason).toContain("額度");
    // 額度是 agent 層級的：用同一家 agent 的其他車道也無法繼續，所以不斷言 T-1 是否已經合併
    const mergedBefore = new Set(paused.doneTasks ?? []);
    writeFileSync(join(root, "lane-config.json"), JSON.stringify({}));
    rmSync(laneLog, { force: true });
    resetQuotaState();
    const resumed = await advance({ ...paused, stage: paused.pausedStage!, pausedStage: undefined, pauseReason: undefined });
    expect(resumed.failureReason).toBeUndefined();
    expect([...(resumed.doneTasks ?? [])].sort()).toEqual(["T-1", "T-2"]);
    for (const t of mergedBefore) expect(laneSteps()).not.toContain(`tests:${t}`);
  });

  it("agent 次數用完時失敗並標示 agent_budget", async () => {
    const id = "f-lanes-budget";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { maxAgentRuns: 2, config: {} });
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("agent_budget");
  });

  it("剩餘一格額度時兩條同時開始的車道只會啟動一個 agent，用量不超過上限", async () => {
    const id = "f-lanes-one-slot";
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { maxAgentRuns: 1, config: {} });
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("agent_budget");
    expect(run.failureReason).toContain("--max-agent-runs");
    expect(laneSteps()).toHaveLength(1); // 只有一個 agent 命令被啟動
    expect(agentRuns(id)).toBe(1);
  });

  it("車道額度不足不是一般錯誤：車道不標成失敗，調高上限 resume 後接續", async () => {
    const id = "f-lanes-budget-resume";
    const failed = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { maxAgentRuns: 3, config: {} });
    expect(failed.failureCategory).toBe("agent_budget");
    expect(failed.failureCategory).not.toBe("error");
    rmSync(laneLog, { force: true });
    const resumed = await advance({ ...failed, maxAgentRuns: 60, stage: failed.failedStage!, attempts: {}, failedStage: undefined, failureReason: undefined, failureCategory: undefined });
    expect(resumed.failureReason).toBeUndefined();
    expect([...(resumed.doneTasks ?? [])].sort()).toEqual(["T-1", "T-2"]);
  });

  it("車道建立失敗（prepareLane）：其他車道仍跑完並合併，run 以帶任務 id 的失敗收尾", async () => {
    const id = "f-lanes-prepare";
    // 預先建一個與車道分支同路徑前綴的分支（git 的目錄／檔案 ref 衝突），讓 T-2 建立車道的 git worktree add 失敗
    await git(root, "branch", `flow/${id}+T-2/擋住`, "main");
    const run = await laneFlowRun(id, { "T-1": [], "T-2": [] }, { config: {}, maxAttempts: 3 });
    expect(run.stage).toBe("failed");
    expect(run.failureReason).toMatch(/^T-2：/);
    expect(run.failureCategory).toBe("error");
    expect(run.doneTasks).toEqual(["T-1"]);
    expect(existsSync(join(worktreeDir(id), "T-1.mjs"))).toBe(true);
  });
});

describe("計畫停點", () => {
  it("完成 plan 停點時已過計畫審查，暫停後 resume stage 指向 implement，不停在 plan_review", async () => {
    const id = "f-stop-plan";
    const script = join(root, "stop-plan.mjs");
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("plan-review.json")) {
  writeFileSync(".flow/plan-review.json", JSON.stringify({ verdict: "approve", items: [] }));
} else {
  writeFileSync(".flow/plan.md", "# 計畫\\n");
  writeFileSync(".flow/tasks.json", JSON.stringify([{ id: "T-1", title: "任務", description: "完成", dependsOn: [], acceptance: ["AC-1"] }]));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["a", "b"],
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "完成" }]));
    const now = new Date().toISOString();
    const run = await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan",
      autopilot: true, maxAgentRuns: 10, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", stopAfter: "plan", createdAt: now, updatedAt: now,
    });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("implement");
    expect(run.pauseReason).toContain("plan");
    expect(existsSync(join(flowDir(id), "tasks.ordered.json"))).toBe(true);
  });

  async function planSettledRun(id: string, extra: { maxAgentRuns: number; maxAgentRunsExplicit?: boolean; autopilot?: boolean; stopAfter?: undefined }, config: object = {}) {
    const script = join(root, `${id}.mjs`);
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.includes("plan-review.json")) {
  writeFileSync(".flow/plan-review.json", JSON.stringify({ verdict: "approve", items: [] }));
} else {
  writeFileSync(".flow/plan.md", "# 計畫\\n");
  writeFileSync(".flow/tasks.json", JSON.stringify([1, 2, 3].map((n) => ({ id: "T-" + n, title: "任務", description: "完成", dependsOn: [], acceptance: ["AC-" + n] }))));
}
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
      cycle: ["a", "b"],
      ...config,
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([1, 2, 3].map((n) => ({ id: `AC-${n}`, description: "完成" }))));
    const now = new Date().toISOString();
    return advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan",
      autopilot: true, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", stopAfter: "plan", createdAt: now, updatedAt: now, ...extra,
    });
  }

  it("計畫定案後，agent 次數上限改為已執行次數加上任務數乘以 20", async () => {
    const id = "f-budget-per-task";
    const run = await planSettledRun(id, { maxAgentRuns: 10 });
    expect(run.failureReason).toBeUndefined();
    expect(run.stage).toBe("paused");
    expect(run.maxAgentRuns).toBe(agentRuns(id) + 3 * 20);
  });

  it("agentRunsPerTask 可以調整每個任務的倍數", async () => {
    const id = "f-budget-per-task-cfg";
    const run = await planSettledRun(id, { maxAgentRuns: 10 }, { agentRunsPerTask: 5 });
    expect(run.maxAgentRuns).toBe(agentRuns(id) + 3 * 5);
  });

  it("明確指定過上限（--max-agent-runs）就不改算", async () => {
    const id = "f-budget-explicit";
    const run = await planSettledRun(id, { maxAgentRuns: 10, maxAgentRunsExplicit: true });
    expect(run.stage).toBe("paused");
    expect(run.maxAgentRuns).toBe(10);
  });

  describe("replan：人工介入計畫", () => {
    const awaiting = (id: string) => planSettledRun(id, { maxAgentRuns: 50, autopilot: false, stopAfter: undefined });

    it("只有等待核准或停在計畫階段的 run 可以重做", async () => {
      const run = await awaiting("f-replan-stage");
      expect(run.stage).toBe("awaiting_approval");
      expect(canReplan(run)).toBe(true);
      expect(canReplan({ ...run, stage: "paused", pausedStage: "plan_fix" })).toBe(true);
      expect(canReplan({ ...run, stage: "failed", failedStage: "implement" })).toBe(false);
      expect(() => replanRun({ ...run, stage: "done" }, {})).toThrow("只有等待核准");
    });

    it("手改後的計畫檔沒通過檢查時丟錯，不改 run", async () => {
      const run = await awaiting("f-replan-invalid");
      writeFileSync(join(flowDir(run.id), "tasks.json"), "壞掉了");
      expect(() => replanRun(run, { note: "補充" })).toThrow("計畫檔案沒有通過檢查");
      expect(getRun(run.id)?.stage).toBe("awaiting_approval");
    });

    it("補充意見：寫成人工補充意見，交給 plan-fix 修訂後回計畫審查", async () => {
      const run = await awaiting("f-replan-note");
      const before = agentRuns(run.id);
      const next = replanRun(run, { note: "T-2 要改用既有的 helper" });
      expect(next.stage).toBe("plan_fix");
      const feedback = readFileSync(join(flowDir(run.id), "feedback.md"), "utf8");
      expect(feedback).toContain("人工補充意見");
      expect(feedback).toContain("T-2 要改用既有的 helper");
      const done = await advance(saveRun(next));
      expect(done.stage).toBe("awaiting_approval");
      expect(agentRuns(run.id) - before).toBe(2); // 一次修訂 + 一次審查
    });

    it("補充意見加 noReview：修訂完直接定案，不再送審", async () => {
      const run = await awaiting("f-replan-note-noreview");
      const before = agentRuns(run.id);
      const done = await advance(saveRun(replanRun(run, { note: "補充", noReview: true })));
      expect(done.stage).toBe("awaiting_approval");
      expect(done.skipPlanReview).toBeUndefined();
      expect(agentRuns(run.id) - before).toBe(1);
    });

    it("手改計畫、沒有補充意見：回計畫審查，不呼叫修訂者", async () => {
      const run = await awaiting("f-replan-hand");
      writeFileSync(join(flowDir(run.id), "plan.md"), "# 計畫\n\n手動補了一段說明\n");
      const before = agentRuns(run.id);
      const next = replanRun(run, {});
      expect(next.stage).toBe("plan_review");
      const done = await advance(saveRun(next));
      expect(done.stage).toBe("awaiting_approval");
      expect(agentRuns(run.id) - before).toBe(1);
    });

    it("手改計畫加 noReview：只做格式檢查就定案，零 agent 呼叫", async () => {
      const run = await awaiting("f-replan-hand-noreview");
      const before = agentRuns(run.id);
      const next = replanRun(run, { noReview: true });
      expect(next.stage).toBe("awaiting_approval");
      expect(agentRuns(run.id)).toBe(before);
    });
  });
});

describe("iterate：在同一個 worktree 開第二輪", () => {
  async function doneRun(id: string, extra: Partial<FlowRun> = {}) {
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    for (const f of ["spec.md", "plan.md", "tasks.json", "tasks.ordered.json", "acceptance.json", "feedback.md", "review.json"]) writeFileSync(join(flowDir(id), f), `第一輪 ${f}`);
    mkdirSync(runDir(id), { recursive: true });
    for (const f of ["confirmations.json", "plan-arbitration.json", "diverge.json"]) writeFileSync(join(runDir(id), f), "[]");
    mkdirSync(join(runDir(id), "parallel-review", "r1"), { recursive: true });
    mkdirSync(join(runDir(id), "lanes", "T-1"), { recursive: true });
    const now = new Date().toISOString();
    return saveRun({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能\n第二行", stage: "done", autopilot: true,
      maxAgentRuns: 40, cycle: ["a", "b"], attempts: { review: 1 }, taskIndex: 3, taskPhase: "review",
      doneTasks: ["T-1"], amendments: { "T-1": 1 }, taskBase: "abc", testsCommit: "def", testsRedos: 1, lastTestsAuthor: "a", fixSource: "review",
      prUrl: "https://github.com/x/y/pull/1", stopAfter: "pr", createdAt: now, updatedAt: now, ...extra,
    });
  }

  it("只有 done 的 run 可以開下一輪，補充需求不能是空的", async () => {
    const run = await doneRun("f-iter-guard");
    await expect(iterateRun({ ...run, stage: "failed" }, { requirement: "補充" })).rejects.toThrow("只有已完成");
    await expect(iterateRun(run, { requirement: "  \n" })).rejects.toThrow("補充需求");
  });

  it("回到 spec：需求附加補充、輪次加一、任務進度與確認項目清空，PR 連結保留", async () => {
    const run = await doneRun("f-iter-reset");
    const next = await iterateRun(run, { requirement: "改用既有的 helper" });
    expect(next.stage).toBe("spec");
    expect(next.round).toBe(2);
    expect(next.requirement.split("\n")[0]).toBe("測試功能");
    expect(next.requirement).toContain("第 2 輪補充需求");
    expect(next.requirement).toContain("改用既有的 helper");
    expect(next.requirement).toContain(".flow/round-1/");
    expect(next.attempts).toEqual({});
    expect([next.taskIndex, next.taskPhase, next.doneTasks]).toEqual([0, "tests", undefined]);
    expect(next.amendments).toBeUndefined();
    expect([next.taskBase, next.testsCommit, next.testsRedos, next.lastTestsAuthor, next.fixSource, next.stopAfter]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(next.prUrl).toBe(run.prUrl);
    for (const f of ["confirmations.json", "plan-arbitration.json", "diverge.json", "parallel-review", "lanes"]) expect(existsSync(join(runDir(run.id), f))).toBe(false);
  });

  it("第一輪的規格與計畫存進 .flow/round-1/，其餘交接檔清掉", async () => {
    const run = await doneRun("f-iter-archive");
    await iterateRun(run, { requirement: "補充" });
    const flow = flowDir(run.id);
    expect(readFileSync(join(flow, "round-1", "spec.md"), "utf8")).toBe("第一輪 spec.md");
    expect(readFileSync(join(flow, "round-1", "tasks.json"), "utf8")).toBe("第一輪 tasks.json");
    expect(readdirSync(flow).sort()).toEqual(["round-1"]);
  });

  it("第三輪把第二輪存成 round-2，round-1 保留", async () => {
    const run = await doneRun("f-iter-third", { round: 2 });
    mkdirSync(join(flowDir(run.id), "round-1"));
    writeFileSync(join(flowDir(run.id), "round-1", "spec.md"), "更早");
    const next = await iterateRun(run, { requirement: "補充" });
    expect(next.round).toBe(3);
    expect(readdirSync(flowDir(run.id)).sort()).toEqual(["round-1", "round-2"]);
    expect(readFileSync(join(flowDir(run.id), "round-1", "spec.md"), "utf8")).toBe("更早");
  });

  it("agent 次數上限：預設從目前已執行次數再給一份額度；明確指定的就視為使用者定的額度", async () => {
    const run = await doneRun("f-iter-budget");
    const used = agentRuns(run.id);
    const auto = await iterateRun(run, { requirement: "補充" });
    expect(auto.maxAgentRuns).toBeGreaterThan(used);
    expect(auto.maxAgentRunsExplicit).toBeUndefined();
    const explicit = await iterateRun(await doneRun("f-iter-budget2"), { requirement: "補充", maxAgentRuns: 7 });
    expect(explicit.maxAgentRuns).toBe(agentRuns("f-iter-budget2") + 7);
    expect(explicit.maxAgentRunsExplicit).toBe(true);
  });
});

describe("任務審查與驗證", () => {
  it("完成 implement 停點後暫停，resume stage 指向 verify", async () => {
    const run = await taskFlowRun("f-stop-implement", { stopAfter: "implement" });
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("verify");
    expect(run.pauseReason).toContain("implement");
  });

  it("完成 verify 停點後暫停，resume stage 指向 review", async () => {
    const run = await taskFlowRun("f-stop-verify", { stopAfter: "verify" });
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("review");
    expect(run.pauseReason).toContain("verify");
  });

  it("停點是 pr 時不暫停，照常完成", async () => {
    const run = await taskFlowRun("f-stop-pr", { stopAfter: "pr" });
    expect(run.stage).toBe("done");
  });

  it("停點在已經走過的階段時不會回頭停下（resume 後從中間階段接續）", async () => {
    const run = await taskFlowRun("f-stop-passed", { stopAfter: "spec" });
    expect(run.stage).toBe("done");
  });

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
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
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
  opts: { agents?: string[]; quorum?: number; planArbiter?: boolean; layers?: Record<string, unknown>; concurrency?: number } = {},
) {
  const agents = opts.agents ?? ["p1", "p2", "p3"];
  const script = join(root, `${id}.mjs`);
  writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const kind = prompt.includes("計畫索引審查者") ? "index" : prompt.includes("計畫群審查者") ? "group" : prompt.includes("plan-arbiter.json") ? "arbiter" : "other";
appendFileSync(${JSON.stringify(join(root, `${id}-seen-prompts.txt`))}, kind + "\\n");
const file = kind === "group" ? ".flow/plan-review-group.json" : ".flow/plan-review.json";
${body}
`);
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(agents.map((name) => [name, { adapter: "command", command: ["node", script] }])),
    cycle: agents, planReviewQuorum: opts.quorum ?? 1, planArbiter: opts.planArbiter ?? true, reviewConcurrency: opts.concurrency ?? 1,
    ...(opts.layers ? { planReviewLayers: opts.layers } : {}),
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
  writeTasks(id, layeredTasks());
}

function planReviewRun(id: string, maxAgentRuns: number, agents = ["p1", "p2", "p3"], attempts: Record<string, number> = {}) {
  const now = new Date().toISOString();
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
    autopilot: true, maxAgentRuns, maxAgentRunsExplicit: true, cycle: agents, planWriter: agents[0], attempts,
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

const seenFile = (id: string) => join(root, `${id}-seen-prompts.txt`);
const seen = (id: string) => readFileSync(seenFile(id), "utf8");
const resetSeen = (id: string) => writeFileSync(seenFile(id), "");
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
    await layeredRun(id, `if (kind === "index") writeFileSync(${JSON.stringify(join(root, `${id}-index-prompt.txt`))}, prompt);
${APPROVE}`);
    await planReviewRun(id, 3);
    const prompt = readFileSync(join(root, `${id}-index-prompt.txt`), "utf8");
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
    // 存檔以輪次加指紋為鍵：第二次是真正的新一輪（第 2 輪），不會沿用第 1 輪的存檔
    const run = await planReviewRun(id, 4, undefined, { "plan-review": 1 });
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
    const g2Failed = JSON.stringify(join(root, `${id}-g2-failed`)); // 旗標寫在絕對路徑：審查者的 .flow/ 在臨時 worktree，事後會被刪掉
    await layeredRun(id, `if (kind === "group" && prompt.includes("G-2") && !existsSync(${g2Failed})) {
  writeFileSync(${g2Failed}, "");
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
    const failedPrefix = JSON.stringify(join(root, `${id}-failed-`)); // 旗標寫在絕對路徑：審查者的 .flow/ 在臨時 worktree，事後會被刪掉
    await layeredRun(id, `const mark = kind === "index" ? "index" : prompt.includes("任務群 G-1") ? "g1" : "g2";
if (kind !== "other" && !existsSync(${failedPrefix} + mark)) {
  writeFileSync(${failedPrefix} + mark, "");
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
    expect(listRetries(id).map((item) => item.key)).toEqual(Array(5).fill("plan-review-run"));
  });

  it("plan-fix 沒寫 plan-replies.md 時，下一輪不會讀到上一輪的回應", async () => {
    const id = "f-plan-replies-stale";
    await layeredRun(id, `if (kind === "index") writeFileSync(${JSON.stringify(join(root, `${id}-index-prompt.txt`))}, prompt);
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
    expect(readFileSync(join(root, `${id}-index-prompt.txt`), "utf8")).not.toContain("上一輪的舊回應");
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

  it("索引與各群審查同時執行", async () => {
    const id = "f-plan-layers-parallel";
    const log = join(root, `${id}-events.log`);
    writeFileSync(log, "");
    // 柵欄：三個呼叫都啟動後才往下；序列執行時第一個會等到逾時，log 不會是 start start start
    await layeredRun(id, `appendFileSync(${JSON.stringify(log)}, "start\\n");
const until = Date.now() + 20000;
while (Date.now() < until && readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((l) => l === "start").length < 3) await new Promise((r) => setTimeout(r, 20));
appendFileSync(${JSON.stringify(log)}, "end\\n");
${APPROVE}`, { concurrency: 8 });
    const run = await planReviewRun(id, 3);
    expect(run.failureReason).toMatch(/達到上限/); // 三個呼叫都成功套用，之後進 implement 時預算用完
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(["start", "start", "start"]); // 索引與兩群同時開始，之後才有人結束
    expect(reviewState(id).reviewed.tasks["T-8"].verdict).toBe("approve");
  });

  it("一個群額度用完時其他呼叫跑完並存檔，resume 只補跑沒完成的", async () => {
    const id = "f-plan-layers-quota";
    const log = join(root, `${id}-calls.log`);
    const flag = join(root, `${id}-quota`);
    writeFileSync(log, "");
    writeFileSync(flag, "");
    // 索引是 slot-0，兩群依序是 slot-1、slot-2；slot-2 額度用完（三者可能是同一家 agent，見腳本內的柵欄）
    await layeredRun(id, `const slot = process.cwd().split("/").pop();
appendFileSync(${JSON.stringify(log)}, kind + ":" + slot + "\\n");
if (slot === "slot-2" && existsSync(${JSON.stringify(flag)})) {
  // 三個呼叫用同一家 agent：先等另外兩個都啟動再回報額度用完，否則還沒啟動的會因這家已額度用完而不執行
  const until = Date.now() + 20000;
  while (Date.now() < until && readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length < 3) await new Promise((r) => setTimeout(r, 20));
  console.error("usage limit reached");
  process.exit(1);
}
${APPROVE}`, { concurrency: 8 });

    const paused = await planReviewRun(id, 3);
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("plan_review");
    expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(["group:slot-1", "group:slot-2", "index:slot-0"]);

    rmSync(flag);
    resetQuotaState(); // 模擬 resume 時是新的程序
    writeFileSync(log, "");
    // 前面已用掉 3 次，這次只剩 1 次可用：剛好夠補跑 slot-2
    const resumed = await planReviewRun(id, 4);
    expect(readFileSync(log, "utf8").trim()).toBe("group:slot-2"); // 索引與 slot-1 沿用存檔，沒有重跑
    expect(resumed.failureReason).toMatch(/達到上限/);
    expect(reviewState(id).reviewed.tasks["T-1"].verdict).toBe("approve");
    expect(reviewState(id).reviewed.tasks["T-8"].verdict).toBe("approve");
  });

  it("adaptive 選模：某一群失敗後只有那一群的重審升級模型", async () => {
    const id = "f-plan-layers-escalate";
    const g2Failed = JSON.stringify(join(root, `${id}-g2-failed`));
    await layeredRun(id, `if (kind === "group" && prompt.includes("任務群 G-2") && !existsSync(${g2Failed})) {
  writeFileSync(${g2Failed}, "");
  writeFileSync(file, "{");
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
${APPROVE}
}`);
    const script = join(root, `${id}.mjs`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: Object.fromEntries(["p1", "p2", "p3"].map((name) => [name, {
        adapter: "command", command: ["node", script, "{model}"], modelProbe: ["node", script, "{model}"],
        models: [{ name: "small", strength: "low" }, { name: "large", strength: "high" }],
      }])),
      cycle: ["p1", "p2", "p3"], planReviewQuorum: 1, planArbiter: true, reviewConcurrency: 1,
      modelSelection: { mode: "adaptive", stageStrength: { planReview: "low" } },
    }));
    const now = new Date().toISOString();
    await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "plan_review",
      autopilot: true, maxAgentRuns: 4, cycle: ["p1", "p2", "p3"], planWriter: "p1", attempts: {}, modelMode: "adaptive",
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    const models = listUsage(id).map((e) => `${e.stage}:${e.model}`);
    expect(models.filter((m) => m === "plan-review:small")).toHaveLength(1);
    expect(models.filter((m) => m === "plan-review-group:small")).toHaveLength(2); // G-1 與 G-2 的第一次
    expect(models.filter((m) => m === "plan-review-group:large")).toHaveLength(1); // 只有 G-2 的重審升級
  }, SLOW_TEST_MS);
});

describe("lint 與型別檢查只在最後驗證", () => {
  const record = (name: string) => `node -e "require('fs').appendFileSync('calls.log', '${name}:' + process.argv.slice(1).join(',') + '\\n')"`;
  async function checkRun(id: string, files: Record<string, string>) {
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: { a: { adapter: "command", command: ["node", script] } }, cycle: ["a"], install: "true",
      checks: [
        { name: "typecheck", cmd: record("typecheck"), finalOnly: true },
        { name: "lint", cmd: record("lint"), finalOnly: true, changedOnly: true },
        { name: "test", cmd: record("test") },
      ],
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(wt, name, ".."), { recursive: true });
      writeFileSync(join(wt, name), content);
    }
    await commitAll(wt, "feat: 測試 [a]");
    mkdirSync(flowDir(id), { recursive: true });
    const now = new Date().toISOString();
    return {
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "implement" as const,
      autopilot: true, maxAgentRuns: 10, cycle: ["a"], attempts: {}, taskIndex: 0, taskPhase: "verify" as const, createdAt: now, updatedAt: now,
    };
  }
  const calls = (id: string) => readFileSync(join(worktreeDir(id), "calls.log"), "utf8").trim().split("\n");

  it("任務驗證只跑沒有標 finalOnly 的檢查", async () => {
    const run = await checkRun("f-chk-task", { "src/a.ts": "export {};\n" });
    expect(await runChecks(run, "T-1-", "task")).toBeUndefined();
    expect(calls("f-chk-task")).toEqual(["test:"]);
  });

  it("最後驗證跑全部，lint 只收到整支分支改過的程式檔", async () => {
    const run = await checkRun("f-chk-final", {
      "src/a.ts": "export {};\n", "docs/readme.md": "# x\n", ".flow/x.ts": "x\n", ".agentflowctl/y.ts": "y\n",
      ".worktree/z.ts": "z\n", ".worktrees/w.ts": "w\n",
    });
    expect(await runChecks(run)).toBeUndefined();
    expect(calls("f-chk-final").sort()).toEqual(["lint:src/a.ts", "test:", "typecheck:"]);
  });

  it("整支分支沒有可檢查的檔案時略過 lint", async () => {
    const run = await checkRun("f-chk-none", { "docs/readme.md": "# x\n" });
    expect(await runChecks(run)).toBeUndefined();
    expect(calls("f-chk-none").sort()).toEqual(["test:", "typecheck:"]);
  });

  async function concurrentRun(id: string, extra: object = {}) {
    // 每個檢查先宣告自己開始，再等另一個也開始；依序執行時會互相等到逾時而失敗
    const waitFor = (self: string, other: string) =>
      `node -e "const fs=require('fs');fs.writeFileSync('${self}.started','');const t=Date.now();while(!fs.existsSync('${other}.started')){if(Date.now()-t>3000)process.exit(1)}"`;
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
      agents: { a: { adapter: "command", command: ["node", script] } }, cycle: ["a"], install: "true",
      checks: [{ name: "one", cmd: waitFor("one", "two") }, { name: "two", cmd: waitFor("two", "one") }],
      ...extra,
    }));
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    const now = new Date().toISOString();
    return {
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "implement" as const,
      autopilot: true, maxAgentRuns: 10, cycle: ["a"], attempts: {}, taskIndex: 0, taskPhase: "verify" as const, createdAt: now, updatedAt: now,
    };
  }

  it("同一次驗證的檢查預設同時執行，verify.json 與 log 序號仍照設定順序、各自獨立", async () => {
    const run = await concurrentRun("f-chk-parallel");
    expect(await runChecks(run)).toBeUndefined();
    const results = JSON.parse(readFileSync(join(flowDir(run.id), "verify.json"), "utf8")) as { name: string }[];
    expect(results.map((r) => r.name)).toEqual(["install", "one", "two"].filter((n) => n !== "install"));
    const logs = readdirSync(logDir(run.id)).filter((f) => /-(one|two)-/.test(f));
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((f) => f.slice(0, 3))).size).toBe(2);
  });

  it("checksConcurrency 為 1 時一次只跑一個檢查", async () => {
    const run = await concurrentRun("f-chk-serial", { checksConcurrency: 1 });
    const report = await runChecks(run);
    expect(report).toContain("one 失敗");
  }, SLOW_TEST_MS);

  it("withFiles：npm run 用 -- 轉給 script，檔名加引號", () => {
    expect(withFiles("pnpm run lint", ["src/a.ts"])).toBe("pnpm run lint 'src/a.ts'");
    expect(withFiles("npm run lint", ["a b.ts", "it's.ts"])).toBe("npm run lint -- 'a b.ts' 'it'\\''s.ts'");
    expect(withFiles("npm run lint -- --ignore-pattern 'x'", ["a.ts"])).toBe("npm run lint -- --ignore-pattern 'x' 'a.ts'");
  });
});
