import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-store-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);
const { addRetry, addSubstitution, addUsage, agentRuns, listRetries, listSubstitutions, getRun, listRuns, saveRun, usageByAgent, usageByStage, usageByStrength, usageByTask } = await import("./store.js");

describe("檔案儲存", () => {
  it("儲存、讀取、列出 run，並累加用量", () => {
    const now = new Date().toISOString();
    saveRun({
      id: "f-a", baseBranch: "main", branch: "flow/f-a", requirement: "r", stage: "spec", autopilot: false,
      maxAgentRuns: 10, cycle: ["claude", "codex"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(getRun("f-a")?.stage).toBe("spec");
    expect(listRuns().map((r) => r.id)).toEqual(["f-a"]);
    addUsage("f-a", { stage: "spec", agent: "claude", inputTokens: 100, outputTokens: 10 });
    addUsage("f-a", { stage: "review", agent: "codex", inputTokens: 50, outputTokens: 5 });
    expect(usageByAgent("f-a").codex).toMatchObject({ tokens: 0, runs: 1, legacyRuns: 1, legacyTokens: 55 });
    expect(agentRuns("f-a")).toBe(2);
    addSubstitution("f-a", { step: "T-1-code", planned: "codex", actual: "claude" });
    expect(listSubstitutions("f-a").map((x) => x.actual)).toEqual(["claude"]);
  });

  it("區分明確回報 0、未回報與舊資料", () => {
    addUsage("f-usage", { stage: "spec", agent: "a", model: "small", strength: "low", usageReported: true, inputTokens: 0, outputTokens: 0 });
    addUsage("f-usage", { stage: "plan", agent: "a", model: "large", strength: "high", usageReported: false });
    addUsage("f-usage", { stage: "review", agent: "a", inputTokens: 0, outputTokens: 0 });
    expect(usageByAgent("f-usage").a).toMatchObject({ tokens: 0, runs: 3, reportedRuns: 1, unreportedRuns: 1, legacyRuns: 1 });
    expect(usageByStrength("f-usage").low).toMatchObject({ tokens: 0, runs: 1, reportedRuns: 1 });
    expect(usageByStrength("f-usage").high).toMatchObject({ tokens: 0, runs: 1, unreportedRuns: 1 });
  });

  it("依階段與任務加總用量，非任務步驟與未知步驟另外歸類", () => {
    const reported = (stage: string, inputTokens: number, outputTokens: number) =>
      addUsage("f-rollup", { stage, agent: "a", usageReported: true, inputTokens, outputTokens });
    reported("plan", 100, 10);
    reported("T-1-tests", 20, 2);
    reported("T-1-code", 30, 3);
    reported("T-1-fix", 5, 1);
    reported("T-2-code", 40, 4);
    reported("review", 60, 6);
    addUsage("f-rollup", { stage: "old-step", agent: "a", inputTokens: 7, outputTokens: 0 });
    const byStage = usageByStage("f-rollup");
    expect(byStage.taskCode).toMatchObject({ tokens: 77, runs: 2 });
    expect(byStage.plan).toMatchObject({ tokens: 110, runs: 1 });
    expect(byStage["其他"]).toMatchObject({ tokens: 0, runs: 1, legacyRuns: 1, legacyTokens: 7 });
    const byTask = usageByTask("f-rollup");
    expect(byTask["T-1"]).toMatchObject({ tokens: 61, inputTokens: 55, outputTokens: 6, runs: 3 });
    expect(byTask["T-2"]).toMatchObject({ tokens: 44, runs: 1 });
    expect(byTask["非任務步驟"]).toMatchObject({ tokens: 176, runs: 3 });
  });

  it("加總 cache 讀寫量，沒有 cache 欄位的紀錄算 0", () => {
    addUsage("f-cache", { stage: "spec", agent: "c", usageReported: true, inputTokens: 43012, outputTokens: 500, cacheReadTokens: 40000, cacheWriteTokens: 3000 });
    addUsage("f-cache", { stage: "plan", agent: "c", usageReported: true, inputTokens: 100, outputTokens: 10 });
    expect(usageByAgent("f-cache").c).toMatchObject({ tokens: 43622, cacheReadTokens: 40000, cacheWriteTokens: 3000 });
  });

  it("依序記錄重試原因，沒有紀錄時回傳空陣列", () => {
    expect(listRetries("f-retry")).toEqual([]);
    addRetry("f-retry", { key: "T-1:tests", stage: "implement", category: "tests_not_red", attempt: 1, final: false });
    addRetry("f-retry", { key: "T-1:tests", stage: "implement", category: "agent_error", attempt: 2, final: true });
    expect(listRetries("f-retry").map((r) => [r.category, r.attempt, r.final])).toEqual([["tests_not_red", 1, false], ["agent_error", 2, true]]);
    expect(listRetries("f-retry")[0]?.at).toMatch(/^\d{4}-/);
  });
});
