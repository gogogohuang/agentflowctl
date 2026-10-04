import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-detect-full-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "^3" } }));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.test.ts"), "expect(1)\n");
execFileSync("git", ["-C", root, "add", "."]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const agentScript = join(root, "fake-agent.mjs");
writeFileSync(agentScript, `import { writeFileSync } from "node:fs"; writeFileSync("../../../called.flag", "1");\n`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({ agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"] }));

const { addWorktree } = await import("./git.js");
const { detectWithAgent } = await import("./engine.js");
const { readDetected } = await import("./detectedFile.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { saveRun } = await import("./store.js");

describe("detectWithAgent：欄位齊全的已辨識專案", () => {
  it("不呼叫 agent", async () => {
    await addWorktree(root, worktreeDir("f-full-1"), "main", "flow/f-full-1");
    mkdirSync(flowDir("f-full-1"), { recursive: true });
    const now = new Date().toISOString();
    const run = saveRun({
      id: "f-full-1", baseBranch: "main", branch: "flow/f-full-1", requirement: "x", stage: "spec" as const,
      autopilot: true, maxAgentRuns: 10, cycle: ["a"], attempts: {}, taskIndex: 0, taskPhase: "tests" as const, createdAt: now, updatedAt: now,
    });
    await detectWithAgent(await run);
    expect(existsSync(join(root, "called.flag"))).toBe(false);
    expect(readDetected(root)).toBeUndefined();
  }, 30_000);
});
