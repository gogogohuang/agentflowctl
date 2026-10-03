import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-amend-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "base.txt"), "base\n");
execFileSync("git", ["-C", root, "add", "base.txt"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const { addWorktree } = await import("./git.js");
const { advance, resetQuotaState } = await import("./engine.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { listRetries } = await import("./store.js");

beforeEach(() => resetQuotaState());

// 紅燈階段：若 .flow/amend-request.txt 存在就把它當成請求寫出（只寫一次），其餘照常寫測試與實作
const script = join(root, "implementer.mjs");
writeFileSync(script, `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const phase = prompt.includes("<red_output>") ? "code" : prompt.includes("<no_tdd>") ? "direct" : "tests";
writeFileSync(\`.flow/prompt-\${phase}.txt\`, prompt);
if (phase === "tests" && existsSync(".flow/amend-request.txt")) renameSync(".flow/amend-request.txt", ".flow/amend-request.json");
if (phase === "code" && existsSync(".flow/amend-code-request.txt")) renameSync(".flow/amend-code-request.txt", ".flow/amend-request.json");
if (phase === "tests") writeFileSync("feature.test.mjs", 'import { answer } from "./feature.mjs";\\nif (answer !== 42) process.exit(1);\\n');
else writeFileSync("feature.mjs", "export const answer = 42;\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function amendRun(id: string, request: unknown, { amendments, maxAgentRuns = 2, requestIn = "amend-request.txt" }: { amendments?: Record<string, number>; maxAgentRuns?: number; requestIn?: string } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
    cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([
    { id: "AC-1", description: "T-1 的條件" }, { id: "AC-2", description: "T-2 的條件" },
  ]));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "第一個", description: "已完成", dependsOn: [], acceptance: ["AC-1"] },
    { id: "T-2", title: "第二個", description: "匯出 answer", dependsOn: ["T-1"], acceptance: ["AC-2"] },
  ]));
  writeFileSync(join(flowDir(id), requestIn), JSON.stringify(request));
  const now = new Date().toISOString();
  // T-1 在 taskIndex 之前，視為已完成；T-2 從紅燈開始，maxAgentRuns 讓第二次 agent 執行後就停下
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns, maxAgentRunsExplicit: true, cycle: ["a", "b"], attempts: {},
    taskIndex: 1, taskPhase: "tests", ...(amendments ? { amendments } : {}), createdAt: now, updatedAt: now,
  });
}

const goodRequest = { target: "T-1", reason: "T-1 的回傳值要改成物件", files: ["feature.mjs"], acceptance: ["answer 為物件"] };
const tasksOf = (id: string) => JSON.parse(readFileSync(join(flowDir(id), "tasks.ordered.json"), "utf8")) as { id: string; kind?: string; dependsOn: string[]; acceptance: string[] }[];

describe("順序模式的修補請求", () => {
  it("合格的請求插入修補任務、重置請求者，下一個執行的是修補任務", async () => {
    const run = await amendRun("amend-ok", goodRequest);
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-3", "T-2"]);
    expect(tasksOf(run.id)[1]).toMatchObject({ kind: "amend", dependsOn: ["T-1"], acceptance: ["AC-3"] });
    expect(tasksOf(run.id)[2]!.dependsOn).toEqual(["T-1", "T-3"]);
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "acceptance.json"), "utf8"))).toContainEqual({ id: "AC-3", description: "answer 為物件" });
    expect(run.amendments).toEqual({ "T-1": 1 });
    expect(run.taskIndex).toBe(1);
    // 第二次 agent 執行寫的是修補任務的紅燈
    expect(readFileSync(join(flowDir(run.id), "prompt-tests.txt"), "utf8")).toContain("T-3");
    expect(existsSync(join(flowDir(run.id), "amend-request.json"))).toBe(false);
    expect(run.taskPhase).toBe("code");
  }, 30_000);

  it("請求者在綠燈階段提出請求時，丟棄實作並回到紅燈，先做修補任務", async () => {
    // 紅燈照常完成並提交，綠燈階段的 agent 才寫出請求；請求檔被消耗後 run 回到紅燈
    const run = await amendRun("amend-code", goodRequest, { requestIn: "amend-code-request.txt", maxAgentRuns: 3 });
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-3", "T-2"]);
    expect(run.amendments).toEqual({ "T-1": 1 });
    expect(run.taskPhase).toBe("code");
    expect(run.testsCommit).toBeDefined();
    expect(existsSync(join(flowDir(run.id), "amend-request.json"))).toBe(false);
    // 第三次 agent 執行寫的是修補任務的紅燈
    expect(readFileSync(join(flowDir(run.id), "prompt-tests.txt"), "utf8")).toContain("T-3");
  }, 30_000);

  it("無效的請求用 retry 把原因寫給請求者，不改任務清單", async () => {
    const run = await amendRun("amend-invalid", { ...goodRequest, target: "T-9" });
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(listRetries(run.id).some((r) => r.category === "amend_invalid")).toBe(true);
    expect(run.amendments).toBeUndefined();
  }, 30_000);

  it("達到修補上限時暫停，並要求請求者在自己的任務內完成", async () => {
    const run = await amendRun("amend-limit", goodRequest, { amendments: { "T-1": 2 }, maxAgentRuns: 5 });
    expect(run.stage).toBe("paused");
    expect(run.pauseReason).toMatch(/T-1.*上限/);
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toContain("修補");
  }, 30_000);
});
