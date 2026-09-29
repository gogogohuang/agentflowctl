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
const { createTempWorktree, tempWorktreesDir } = await import("./tempWorktree.js");

beforeEach(() => resetQuotaState());

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
