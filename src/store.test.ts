import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-store-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);
const { addSubstitution, addUsage, agentRuns, listSubstitutions, getRun, listRuns, saveRun, usageByAgent } = await import("./store.js");

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
    expect(usageByAgent("f-a").codex).toEqual({ tokens: 55, runs: 1 });
    expect(agentRuns("f-a")).toBe(2);
    addSubstitution("f-a", { step: "T-1-code", planned: "codex", actual: "claude" });
    expect(listSubstitutions("f-a").map((x) => x.actual)).toEqual(["claude"]);
  });
});
