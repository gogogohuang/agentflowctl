import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-store-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);
const { runDir } = await import("./paths.js");
const { releaseAgentRun, reserveAgentRun, resetAgentRunReservations, addRetry, addSubstitution, addUsage, agentRuns, listRetries, listSubstitutions, listUsage, getRun, listRuns, saveRun, summarizeUsage, totalUsage, usageByAgent, usageByStage, usageByStrength, usageByTask, usageKeyAgent, usageKeyModelStage, usageKeyModelStageKind } = await import("./store.js");

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
    addRetry("f-retry", { key: "T-1:tests", backTo: "implement", category: "tests_not_red", attempt: 1, final: false });
    addRetry("f-retry", { key: "T-1:tests", backTo: "implement", category: "agent_error", attempt: 2, final: true });
    expect(listRetries("f-retry").map((r) => [r.category, r.attempt, r.final])).toEqual([["tests_not_red", 1, false], ["agent_error", 2, true]]);
    expect(listRetries("f-retry")[0]?.at).toMatch(/^\d{4}-/);
  });

  it("jsonl 有寫到一半的殘行時略過該行", () => {
    addRetry("f-torn", { key: "spec", backTo: "spec", category: "agent_error", attempt: 1, final: false });
    appendFileSync(join(runDir("f-torn"), "retries.jsonl"), `{"key":"spec","ba`);
    addSubstitution("f-torn", { step: "spec", planned: "a", actual: "b" });
    appendFileSync(join(runDir("f-torn"), "substitutions.jsonl"), "{");
    expect(listRetries("f-torn").map((r) => r.key)).toEqual(["spec"]);
    expect(listSubstitutions("f-torn")).toHaveLength(1);
  });

  it("重試寫入後尚未存回 state 就中斷，resume 重跑同一步不重複記錄", () => {
    const saved = new Date(Date.now() - 60_000).toISOString();
    const entry = { key: "plan", backTo: "plan", category: "format_invalid" as const, attempt: 1, final: false };
    addRetry("f-dup", entry, saved);
    addRetry("f-dup", entry, saved); // state 仍是寫入前的版本
    expect(listRetries("f-dup")).toHaveLength(1);
    // state 已存過（updatedAt 晚於紀錄），resume 後重新計數的 attempt 1 要照常記錄
    addRetry("f-dup", entry, new Date(Date.now() + 60_000).toISOString());
    expect(listRetries("f-dup")).toHaveLength(2);
  });

  it("對記憶體中的用量分組，不讀檔", () => {
    const entries = [
      { stage: "spec", agent: "a", usageReported: true as const, inputTokens: 10, outputTokens: 1, cacheReadTokens: 4 },
      { stage: "plan", agent: "b", usageReported: true as const, inputTokens: 20, outputTokens: 2 },
      { stage: "review", agent: "a", usageReported: false as const },
    ];
    expect(totalUsage(entries)).toMatchObject({
      tokens: 33, inputTokens: 30, outputTokens: 3, cacheReadTokens: 4, runs: 3, reportedRuns: 2, unreportedRuns: 1,
    });
    expect(summarizeUsage(entries, usageKeyAgent).a).toMatchObject({ tokens: 11, runs: 2, reportedRuns: 1, unreportedRuns: 1 });
    expect(summarizeUsage([], usageKeyAgent)).toEqual({});
    expect(usageKeyModelStage({ stage: "plan", agent: "a" })).toBe("CLI 預設（名稱未知） / plan");
    expect(usageKeyModelStage({ stage: "T-1-code", agent: "a", model: "small" })).toBe("small / T-1-code");
    expect(usageKeyModelStageKind({ stage: "T-1-code", agent: "a", model: "small" })).toBe("small / taskCode");
    expect(usageKeyModelStageKind({ stage: "odd-step", agent: "a" })).toBe("CLI 預設（名稱未知） / odd-step");
  });

  it("用量 jsonl 殘行略過，不讓整份讀失敗", () => {
    addUsage("f-torn-u", { stage: "spec", agent: "a", usageReported: true, inputTokens: 1, outputTokens: 1 });
    appendFileSync(join(runDir("f-torn-u"), "costs.jsonl"), "{");
    expect(listUsage("f-torn-u")).toHaveLength(1);
    expect(agentRuns("f-torn-u")).toBe(1);
  });

  it("reservation：已寫入的用量加上保留數不超過上限，釋放後可再保留", () => {
    resetAgentRunReservations();
    const now = new Date().toISOString();
    saveRun({
      id: "f-r", baseBranch: "main", branch: "flow/f-r", requirement: "r", stage: "spec", autopilot: false,
      maxAgentRuns: 3, cycle: ["claude"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    addUsage("f-r", { stage: "spec", agent: "claude" });
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    expect(reserveAgentRun("f-r", 3)).toBe(false);
    releaseAgentRun("f-r");
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    releaseAgentRun("f-r");
    releaseAgentRun("f-r");
    releaseAgentRun("f-r"); // 多釋放不會變成負數
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    expect(reserveAgentRun("f-r", 3)).toBe(false);
    resetAgentRunReservations();
    expect(reserveAgentRun("f-r", 3)).toBe(true);
    resetAgentRunReservations();
  });

  it("reservation：車道與所屬 run 共用同一份", () => {
    resetAgentRunReservations();
    expect(reserveAgentRun("f-r", 2)).toBe(true); // 已有 1 筆用量
    expect(reserveAgentRun("f-r+T-1", 2)).toBe(false);
    resetAgentRunReservations();
  });
});
