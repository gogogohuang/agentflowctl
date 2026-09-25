import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addWorktree, changedFiles, commitAll, discardChanges, headCommit, removeWorktree, resetTo } from "./git.js";

let root: string;
let wt: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agentflowctl-"));
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  wt = join(root, ".agentflowctl", "worktrees", "f-1");
  await addWorktree(root, wt, "main", "flow/f-1");
});

describe("git 工具", () => {
  it("在專案資料夾內建立 worktree，且 .agentflowctl 不會出現在主專案的變更中", async () => {
    expect(existsSync(join(wt, "a.ts"))).toBe(true);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".agentflowctl/");
  });

  it(".flow/ 不會被 commit，也不會被 reset 清掉", async () => {
    execFileSync("mkdir", ["-p", join(wt, ".flow")]);
    writeFileSync(join(wt, ".flow", "spec.md"), "# spec");
    expect(await commitAll(wt, "noop")).toBeUndefined();
    writeFileSync(join(wt, "junk.ts"), "x");
    await discardChanges(wt);
    expect(existsSync(join(wt, "junk.ts"))).toBe(false);
    expect(existsSync(join(wt, ".flow", "spec.md"))).toBe(true);
  });

  it("列出變更與刪除的檔案，並可還原", async () => {
    const base = await headCommit(wt);
    writeFileSync(join(wt, "a.test.ts"), "test");
    const c1 = await commitAll(wt, "add test");
    expect(await changedFiles(wt, base, c1!)).toEqual(["a.test.ts"]);
    execFileSync("git", ["-C", wt, "rm", "-q", "a.test.ts"]);
    const c2 = await commitAll(wt, "delete test");
    expect(await changedFiles(wt, c1!, c2!, "D")).toEqual(["a.test.ts"]);
    await resetTo(wt, c1!);
    expect(existsSync(join(wt, "a.test.ts"))).toBe(true);
  });

  it("commit 會出現在主專案的分支上，移除 worktree 後分支仍在", async () => {
    writeFileSync(join(wt, "b.ts"), "b");
    await commitAll(wt, "add b");
    await removeWorktree(root, wt);
    const log = execFileSync("git", ["-C", root, "log", "--oneline", "flow/f-1"], { encoding: "utf8" });
    expect(log).toContain("add b");
  });
});
