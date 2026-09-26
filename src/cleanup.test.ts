import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-cleanup-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
execFileSync("git", ["-C", root, "add", "-A"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
process.chdir(root);
const { cleanRun, cleanableRuns } = await import("./cleanup.js");
const { saveRun } = await import("./store.js");
const { addWorktree } = await import("./git.js");
const { runDir, worktreeDir } = await import("./paths.js");
import type { Stage } from "./schemas.js";

const worktrees = () => execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });
const branchExists = (b: string) => execFileSync("git", ["-C", root, "branch", "--list", b], { encoding: "utf8" }).trim() !== "";

async function makeRun(id: string, stage?: Stage) {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  if (!stage) return;
  const now = new Date().toISOString();
  saveRun({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "r", stage, autopilot: true,
    maxAgentRuns: 10, cycle: ["claude"], attempts: {}, taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
  });
}

describe("清除 worktree", () => {
  it("清除有紀錄的 run：worktree 與紀錄都移除，分支保留", async () => {
    await makeRun("f-ok", "failed");
    expect(await cleanRun("f-ok")).toBe(true);
    expect(existsSync(worktreeDir("f-ok"))).toBe(false);
    expect(existsSync(runDir("f-ok"))).toBe(false);
    expect(worktrees()).not.toContain("f-ok");
    expect(branchExists("flow/f-ok")).toBe(true);
  });

  it("沒有 state.json 的孤兒 worktree 也能清", async () => {
    await makeRun("f-orphan");
    mkdirSync(join(runDir("f-orphan"), "logs"), { recursive: true });
    expect(await cleanRun("f-orphan")).toBe(true);
    expect(existsSync(worktreeDir("f-orphan"))).toBe(false);
    expect(existsSync(runDir("f-orphan"))).toBe(false);
    expect(worktrees()).not.toContain("f-orphan");
  });

  it("worktree 資料夾被手動刪掉時，清掉 git 殘留的登記", async () => {
    await makeRun("f-gone", "failed");
    rmSync(worktreeDir("f-gone"), { recursive: true, force: true });
    expect(await cleanRun("f-gone")).toBe(true);
    expect(worktrees()).not.toContain("f-gone");
  });

  it("什麼都找不到時回傳 false", async () => {
    expect(await cleanRun("f-none")).toBe(false);
  });

  it("拒絕會刪到別處的 id", async () => {
    for (const id of ["", "..", "../x", "a/b"]) await expect(cleanRun(id)).rejects.toThrow("不合法");
  });

  it("--all 只挑已結束的 run 與孤兒，不動進行中、暫停、等待核准的", async () => {
    await makeRun("f-done", "done");
    await makeRun("f-fail", "failed");
    await makeRun("f-lost");
    await makeRun("f-impl", "implement");
    await makeRun("f-pause", "paused");
    await makeRun("f-wait", "awaiting_approval");
    const found = cleanableRuns();
    expect(found.map((r) => r.id).sort()).toEqual(["f-done", "f-fail", "f-lost"]);
    expect(found.find((r) => r.id === "f-lost")?.stage).toBeUndefined();
    expect(found.find((r) => r.id === "f-done")?.stage).toBe("done");
  });
});
