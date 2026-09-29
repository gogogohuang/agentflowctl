import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-temp-wt-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
execFileSync("git", ["-C", root, "add", "-A"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
process.chdir(root);

const { addWorktree } = await import("./git.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { cleanupTempWorktrees, createTempWorktree, tempWorktreesDir, withTempWorktree } = await import("./tempWorktree.js");

async function setupRun(id: string) {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "spec.md"), "# spec\n");
}

const listed = () => execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });

describe("臨時 worktree", () => {
  it("內容是 HEAD 加複製的 .flow，改動不影響 run 的 worktree，結束後被移除", async () => {
    await setupRun("t-basic");
    let dir = "";
    await withTempWorktree("t-basic", "slot-0", async (ws) => {
      dir = ws.dir;
      expect(readFileSync(join(ws.dir, "a.ts"), "utf8")).toContain("a = 1");
      expect(readFileSync(join(ws.flow, "spec.md"), "utf8")).toBe("# spec\n");
      writeFileSync(join(ws.dir, "a.ts"), "亂改");
      writeFileSync(join(ws.flow, "spec.md"), "亂改");
      expect(listed()).toContain(ws.dir);
    });
    expect(readFileSync(join(worktreeDir("t-basic"), "a.ts"), "utf8")).toContain("a = 1");
    expect(readFileSync(join(flowDir("t-basic"), "spec.md"), "utf8")).toBe("# spec\n");
    expect(existsSync(dir)).toBe(false);
    expect(listed()).not.toContain(dir);
  });

  it("fn 丟例外時也會移除", async () => {
    await setupRun("t-throw");
    let dir = "";
    await expect(withTempWorktree("t-throw", "slot-0", async (ws) => {
      dir = ws.dir;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(dir)).toBe(false);
    expect(listed()).not.toContain(dir);
  });

  it("同時建立的多個臨時 worktree 互相獨立", async () => {
    await setupRun("t-par");
    const dirs = await Promise.all([0, 1, 2].map((n) => withTempWorktree("t-par", `slot-${n}`, async (ws) => {
      writeFileSync(join(ws.flow, "out.json"), String(n));
      await new Promise((r) => setTimeout(r, 50));
      return { dir: ws.dir, out: readFileSync(join(ws.flow, "out.json"), "utf8") };
    })));
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(3);
    expect(dirs.map((d) => d.out)).toEqual(["0", "1", "2"]);
  });

  it("cleanupTempWorktrees 清掉中斷後留下的殘骸與 git 的登記", async () => {
    await setupRun("t-orphan");
    const ws = await createTempWorktree("t-orphan", "slot-0"); // 模擬程序被中斷，沒有機會移除
    expect(listed()).toContain(ws.dir);
    await cleanupTempWorktrees("t-orphan");
    expect(existsSync(tempWorktreesDir("t-orphan"))).toBe(false);
    expect(listed()).not.toContain(ws.dir);
  });

  it("沒有殘骸、甚至沒有 run worktree 時 cleanupTempWorktrees 不出錯", async () => {
    await expect(cleanupTempWorktrees("t-none")).resolves.toBeUndefined();
  });
});
