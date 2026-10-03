import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-detect-agent-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
execFileSync("git", ["-C", root, "add", "Makefile"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

// 假 agent：把 proposal 寫進 .flow/detect-proposal.json（內容由 PROPOSAL 檔決定）
const agentScript = join(root, "fake-agent.mjs");
writeFileSync(agentScript, `import { copyFileSync, existsSync } from "node:fs";
if (existsSync("../../../proposal.json")) copyFileSync("../../../proposal.json", ".flow/detect-proposal.json");
`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({
  agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"],
}));

const { addWorktree } = await import("./git.js");
const { detectWithAgent } = await import("./engine.js");
const { readDetected } = await import("./detectedFile.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { saveRun } = await import("./store.js");

async function newRun(id: string) {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  const now = new Date().toISOString();
  return saveRun({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "spec" as const,
    autopilot: true, maxAgentRuns: 10, cycle: ["a"], attempts: {}, taskIndex: 0, taskPhase: "tests" as const,
    createdAt: now, updatedAt: now,
  });
}

describe("detectWithAgent", () => {
  it("未知類型：提案經驗證後寫入 detected.json，壞的欄位被丟掉並記錄原因", async () => {
    writeFileSync(join(root, "proposal.json"), JSON.stringify({
      install: "true", test: "sh -c 'exit 0'", checks: [{ name: "bad", cmd: "sh -c 'exit 1'" }],
    }));
    const run = await newRun("f-detect-1");
    await detectWithAgent(run);
    const saved = readDetected(root);
    expect(saved?.test).toBe("sh -c 'exit 0'");
    expect(saved?.install).toBeUndefined();
    expect(saved?.checks).toEqual([]);
    expect(saved?.dropped.map((d) => d.field).sort()).toEqual(["checks.bad", "install"]);
  }, 30_000);

  it("指紋沒變時不再呼叫 agent", async () => {
    const run = await newRun("f-detect-2");
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
    expect(existsSync(join(flowDir("f-detect-2"), "detect-proposal.json"))).toBe(false);
  }, 30_000);
});
