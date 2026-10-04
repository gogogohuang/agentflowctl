import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// 內建的 python profile 目前守門欄位齊全，要模擬「已辨識但有缺口」只能在這個檔案把 assertPattern 拿掉
vi.mock("./profile.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./profile.js")>();
  return { ...orig, PYTHON_PROFILE: { ...orig.PYTHON_PROFILE, assertPattern: undefined } };
});

const root = mkdtempSync(join(tmpdir(), "agentflowctl-detect-profile-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "requirements.txt"), "pytest\n");
mkdirSync(join(root, "tests"));
writeFileSync(join(root, "tests", "test_a.py"), "def test_a():\n    assert 1\n");
execFileSync("git", ["-C", root, "add", "."]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const agentScript = join(root, "fake-agent.mjs");
writeFileSync(agentScript, `import { copyFileSync, writeFileSync } from "node:fs";
writeFileSync("../../../called.flag", "1");
copyFileSync("../../../proposal.json", ".flow/detect-proposal.json");
`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({ agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"] }));

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

describe("detectWithAgent：已辨識專案的守門缺口", () => {
  it("缺 assertPattern 時呼叫 agent，只寫入新欄位，install／test／checks 一律忽略", async () => {
    writeFileSync(join(root, "proposal.json"), JSON.stringify({
      install: "true", test: "sh -c 'exit 0'", testPattern: "x", checks: [{ name: "c", cmd: "sh -c 'exit 0'" }],
      assertPattern: { pattern: "\\bcheck\\(", example: "check(x)" },
    }));
    await detectWithAgent(await newRun("f-prof-1"));
    expect(existsSync(join(root, "called.flag"))).toBe(true);
    const saved = readDetected(root);
    expect(saved?.assertPattern).toBe("\\bcheck\\(");
    expect(saved?.install).toBeUndefined();
    expect(saved?.test).toBeUndefined();
    expect(saved?.checks).toEqual([]);
    expect(saved?.testPattern).toBeUndefined();
  }, 30_000);
});
