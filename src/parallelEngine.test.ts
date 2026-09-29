import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-parallel-engine-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "base.txt"), "base\n");
execFileSync("git", ["-C", root, "add", "base.txt"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const { addWorktree, commitAll } = await import("./git.js");
const { advance, resetQuotaState } = await import("./engine.js");
const { mergeHandoff } = await import("./handoff.js");
const { flowDir, logDir, runDir, worktreeDir } = await import("./paths.js");
const { listRetries } = await import("./store.js");
const { createTempWorktree, tempWorktreesDir } = await import("./tempWorktree.js");

beforeEach(() => resetQuotaState());

/** 審查者腳本：記錄自己在哪個 slot 啟動與結束，可睡一下、可模擬額度用完、可亂改檔案 */
function writeReviewer(name: string): string {
  const file = join(root, name);
  writeFileSync(file, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const ROOT = ${JSON.stringify(root)};
const slot = basename(process.cwd());
const mode = readFileSync(".flow/review-mode.txt", "utf8").trim();
appendFileSync(ROOT + "/events.log", "start " + slot + "\\n");
if (existsSync(ROOT + "/quota-" + slot)) { console.error("usage limit reached"); process.exit(1); }
if (existsSync(ROOT + "/sleep")) await new Promise((r) => setTimeout(r, Number(readFileSync(ROOT + "/sleep", "utf8"))));
if (existsSync(ROOT + "/tamper")) { writeFileSync("feature.ts", "亂改"); writeFileSync(".flow/acceptance.json", "[]"); }
const context = readFileSync(".flow/handoff-context.md", "utf8");
const id = context.match(/## ([a-f0-9]+)：/)?.[1];
writeFileSync(mode.startsWith("plan-") ? ".flow/plan-review.json" : ".flow/review.json", JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({
  newIssues: [],
  dispositions: mode.endsWith("close") && id ? [{ id, status: "resolved", reason: "已核對", evidence: "src/api.test.ts:25" }] : [],
}));
appendFileSync(ROOT + "/events.log", "end " + slot + "\\n");
`);
  return file;
}

const events = () => (existsSync(join(root, "events.log")) ? readFileSync(join(root, "events.log"), "utf8").trim().split("\n") : []);
const resetEvents = () => writeFileSync(join(root, "events.log"), "");
const setFlag = (name: string, value = "") => writeFileSync(join(root, name), value);
const clearFlag = (name: string) => rmSync(join(root, name), { force: true });

const baseRun = (id: string, stage: "plan_review" | "review", extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return {
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage,
    autopilot: true, maxAgentRuns: 10, cycle: ["a", "b", "c"], attempts: {},
    // 計畫審查通過後會接著進 implement；測試只關心審查，所以停在計畫階段結束的邊界
    ...(stage === "plan_review" ? { stopAfter: "plan" as const } : {}),
    taskIndex: 0, taskPhase: "tests" as const, createdAt: now, updatedAt: now, ...extra,
  };
};

function configure(script: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b", "c"].map((n) => [n, { adapter: "command", command: ["node", script] }])),
    cycle: ["a", "b", "c"], ...extra,
  }));
}

/** 計畫審查用的 run：計畫作者 a，審查者從 b、c 選；沒有 tasks.json，走整份審查 */
async function planReviewSetup(id: string, mode: "plan-close" | "plan-open" = "plan-close") {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "review-mode.txt"), mode);
  const tasks = [{ id: "T-1", title: "任務 T-1", description: "改 src/a.ts", dependsOn: [] as string[], acceptance: ["AC-1"], complexity: "low" }];
  writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
  writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n整體做法\n\n## T-1 難度\n低\n");
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "匯出 answer" }]));
  writeFileSync(join(flowDir(id), "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify(tasks));
  const source = { stage: "spec" as const, step: "spec", agent: "a", callKey: `${id}:spec` };
  mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "計畫待核對", evidence: "spec.md:2", targetStage: "plan" }], dispositions: [] }, "writer");
}

const listed = () => execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });

describe("孤兒臨時 worktree", () => {
  it("advance 開頭清掉上次中斷留下的臨時 worktree", async () => {
    const id = "pe-orphan";
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    const ws = await createTempWorktree(id, "slot-0"); // 模擬 Ctrl-C 時沒有機會移除
    expect(listed()).toContain(ws.dir);
    const now = new Date().toISOString();
    await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "done",
      autopilot: true, maxAgentRuns: 10, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(existsSync(tempWorktreesDir(id))).toBe(false);
    expect(listed()).not.toContain(ws.dir);
  });
});

describe("整份計畫審查平行", () => {
  it("兩位審查者同時執行，log 序號不撞號", async () => {
    const id = "pe-plan-par";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("sleep", "300");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("sleep");
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("implement"); // 計畫審查全數核准，停在計畫階段的邊界
    // 兩個都開始之後才有人結束
    expect(events().slice(0, 2).every((line) => line.startsWith("start"))).toBe(true);
    expect(events().slice(2).every((line) => line.startsWith("end"))).toBe(true);
    const seqs = readdirSync(logDir(id)).map((f) => f.split("-")[0]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("reviewConcurrency 為 1 時一次一位", async () => {
    const id = "pe-plan-seq";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2, reviewConcurrency: 1 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("sleep", "100");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("sleep");
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("implement");
    expect(events().map((line) => line.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  });

  it("審查者亂改程式碼與 .flow 不會動到共用的 worktree", async () => {
    const id = "pe-plan-tamper";
    configure(writeReviewer("reviewer.mjs"));
    await planReviewSetup(id);
    setFlag("tamper");
    const before = readFileSync(join(flowDir(id), "acceptance.json"), "utf8");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", stopAfter: "plan" }));
    clearFlag("tamper");
    expect(run.stage).toBe("paused");
    expect(readFileSync(join(flowDir(id), "acceptance.json"), "utf8")).toBe(before);
    expect(existsSync(join(worktreeDir(id), "feature.ts"))).toBe(false);
    expect(execFileSync("git", ["-C", worktreeDir(id), "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("額度用完：其他審查者跑完並存檔後暫停；resume 只補跑沒完成的", async () => {
    const id = "pe-plan-quota";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("plan_review");
    expect(events().filter((line) => line === "end slot-0")).toHaveLength(1); // slot-0 完整跑完
    clearFlag("quota-slot-1");

    resetQuotaState(); // 模擬 resume 時是新的程序
    resetEvents();
    const resumed = await advance({ ...paused, stage: "plan_review", pausedStage: undefined, pauseReason: undefined });
    expect(resumed.stage).toBe("paused");
    expect(resumed.pausedStage).toBe("implement");
    expect(events()).not.toContain("start slot-0"); // 沿用已存檔的結果，沒有重跑
    expect(events()).toContain("start slot-1");
  });

  it("已存檔的結果損毀時當作沒有並重跑", async () => {
    const id = "pe-plan-corrupt";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("quota-slot-1");
    const dir = join(runDir(id), "parallel-review", "plan-review");
    const round = join(dir, readdirSync(dir)[0]!);
    for (const f of readdirSync(round)) writeFileSync(join(round, f), "{ 壞掉");

    resetQuotaState();
    resetEvents();
    const resumed = await advance({ ...paused, stage: "plan_review", pausedStage: undefined, pauseReason: undefined });
    expect(resumed.stage).toBe("paused");
    expect(resumed.pausedStage).toBe("implement");
    expect(events()).toContain("start slot-0"); // 損毀的被丟掉，重跑
  });

  it("預算不足時只啟動預算內的呼叫，run 以 agent_budget 失敗", async () => {
    const id = "pe-plan-budget";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", maxAgentRuns: 1 }));
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("agent_budget");
    expect(events().filter((line) => line.startsWith("start"))).toHaveLength(1);
  });
});

/** 分裂裁決：slot-0 要求修改並新增計畫事項；slot-1 在看得到該事項時要求修改，看不到時核准並結掉原有事項（一輪內的審查者都從同一份帳本開始，所以 slot-1 一律看不到） */
function writeSplitReviewer(name: string): string {
  const file = join(root, name);
  writeFileSync(file, `import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const slot = basename(process.cwd());
const context = readFileSync(".flow/handoff-context.md", "utf8");
const id = context.match(/## ([a-f0-9]+)：/)?.[1];
const object = { verdict: "changes_requested", items: [{ criterion: "範圍", status: "not_met", note: "太大" }] };
if (slot === "slot-0") {
  writeFileSync(".flow/plan-review.json", JSON.stringify(object));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({
    newIssues: [{ kind: "action", summary: "並行新增事項", evidence: "plan.md:2", targetStage: "plan" }], dispositions: [],
  }));
} else if (context.includes("並行新增事項")) {
  writeFileSync(".flow/plan-review.json", JSON.stringify(object));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
} else {
  writeFileSync(".flow/plan-review.json", JSON.stringify({ verdict: "approve", items: [] }));
  writeFileSync(".flow/handoff-response.json", JSON.stringify({
    newIssues: [], dispositions: id ? [{ id, status: "resolved", reason: "已核對", evidence: "src/api.test.ts:25" }] : [],
  }));
}
`);
  return file;
}

describe("分裂裁決的核准關卡", () => {
  it("平行時核准者不會因為同輪其他審查者新增的事項而被判矛盾", async () => {
    const id = "pe-plan-split-par";
    configure(writeSplitReviewer("split.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", maxAgentRuns: 2 }));
    // 兩位審查者用掉預算，一輪審查正常結束（要求修改）後要進 plan_fix 時因預算用完停下
    expect(listRetries(id).filter((r) => r.category === "handoff_invalid")).toEqual([]);
    expect(run.attempts["plan-review-run"]).toBeUndefined();
    expect(run.attempts["plan-review"]).toBe(1);
    expect(listRetries(id).map((r) => r.category)).toEqual(["review_changes"]);
    expect(run.failureCategory).toBe("agent_budget");
    expect(run.failedStage).toBe("plan_fix");
  });

  it("reviewConcurrency 為 1 時同樣走到 plan_fix，也沒有 handoff_invalid", async () => {
    const id = "pe-plan-split-seq";
    configure(writeSplitReviewer("split.mjs"), { planReviewQuorum: 2, reviewConcurrency: 1 });
    await planReviewSetup(id);
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", maxAgentRuns: 2 }));
    // 兩位審查者用掉預算，一輪審查正常結束（要求修改）後要進 plan_fix 時因預算用完停下
    expect(listRetries(id).filter((r) => r.category === "handoff_invalid")).toEqual([]);
    expect(run.attempts["plan-review-run"]).toBeUndefined();
    expect(listRetries(id).map((r) => r.category)).toEqual(["review_changes"]);
    expect(run.failureCategory).toBe("agent_budget");
    expect(run.failedStage).toBe("plan_fix");
  });
});
