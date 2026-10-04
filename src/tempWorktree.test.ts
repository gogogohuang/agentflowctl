import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-temp-wt-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
execFileSync("git", ["-C", root, "add", "-A"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
process.chdir(root);

const { linkDepDirs } = await import("./engine.js");
const { addWorktree } = await import("./git.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { cleanupTempWorktrees, createTempWorktree, removeTempWorktree, tempWorktreesDir, withTempWorktree } = await import("./tempWorktree.js");

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
    await withTempWorktree("t-basic", "slot-0", [], async (ws) => {
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
    await expect(withTempWorktree("t-throw", "slot-0", [], async (ws) => {
      dir = ws.dir;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(dir)).toBe(false);
    expect(listed()).not.toContain(dir);
  });

  it("同時建立的多個臨時 worktree 互相獨立", async () => {
    await setupRun("t-par");
    const dirs = await Promise.all([0, 1, 2].map((n) => withTempWorktree("t-par", `slot-${n}`, [], async (ws) => {
      writeFileSync(join(ws.flow, "out.json"), String(n));
      await new Promise((r) => setTimeout(r, 50));
      return { dir: ws.dir, out: readFileSync(join(ws.flow, "out.json"), "utf8") };
    })));
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(3);
    expect(dirs.map((d) => d.out)).toEqual(["0", "1", "2"]);
  });

  it("cleanupTempWorktrees 清掉中斷後留下的殘骸與 git 的登記", async () => {
    await setupRun("t-orphan");
    const ws = await createTempWorktree("t-orphan", "slot-0", []); // 模擬程序被中斷，沒有機會移除
    expect(listed()).toContain(ws.dir);
    await cleanupTempWorktrees("t-orphan");
    expect(existsSync(tempWorktreesDir("t-orphan"))).toBe(false);
    expect(listed()).not.toContain(ws.dir);
  });

  it("沒有殘骸、甚至沒有 run worktree 時 cleanupTempWorktrees 不出錯", async () => {
    await expect(cleanupTempWorktrees("t-none")).resolves.toBeUndefined();
  });

  it("依序建立、移除、再建立同一個 slot 時重用同一個固定路徑", async () => {
    await setupRun("t-stable");
    const a = await createTempWorktree("t-stable", "slot-0", []);
    expect(a.dir).toBe(join(tempWorktreesDir("t-stable"), "slot-0"));
    await removeTempWorktree("t-stable", a);
    expect(listed()).not.toContain(a.dir);
    const b = await createTempWorktree("t-stable", "slot-0", []);
    expect(b.dir).toBe(a.dir);
    await removeTempWorktree("t-stable", b);
  });

  it("固定路徑還有人在用時改用唯一路徑（basename 不變），移除它不會動到還在用的那個", async () => {
    await setupRun("t-busy");
    const live = await createTempWorktree("t-busy", "slot-0", []);
    const other = await createTempWorktree("t-busy", "slot-0", []); // 例如被中斷的前一個程序的 agent 還在用固定路徑
    expect(other.dir).not.toBe(live.dir);
    expect(basename(other.dir)).toBe("slot-0");
    await removeTempWorktree("t-busy", other);
    expect(existsSync(other.dir)).toBe(false);
    expect(listed()).not.toContain(other.dir);
    expect(readFileSync(join(live.flow, "spec.md"), "utf8")).toBe("# spec\n");
    expect(listed()).toContain(live.dir);
    await removeTempWorktree("t-busy", live);
  });

  it("固定路徑有 locked 的殘留登記（目錄已不在）時改用唯一路徑，不會失敗", async () => {
    await setupRun("t-stale-lock");
    const orphan = await createTempWorktree("t-stale-lock", "slot-0", []);
    execFileSync("git", ["-C", root, "worktree", "lock", orphan.dir]);
    rmSync(orphan.dir, { recursive: true, force: true }); // 模擬 git 在 worktree add 途中被強制中止
    const ws = await createTempWorktree("t-stale-lock", "slot-0", []);
    expect(ws.dir).not.toBe(orphan.dir);
    expect(basename(ws.dir)).toBe("slot-0");
    expect(listed()).toContain(ws.dir);
    await removeTempWorktree("t-stale-lock", ws);
    await cleanupTempWorktrees("t-stale-lock");
    expect(listed()).not.toContain(orphan.dir);
  });

  it("移除失敗時 withTempWorktree 仍回傳 callback 的結果，或丟出 callback 自己的錯誤", async () => {
    if (process.getuid?.() === 0) return; // root 不受目錄權限限制，無法模擬移除失敗
    await setupRun("t-remove-fail");
    const lockDir = () => chmodSync(tempWorktreesDir("t-remove-fail"), 0o555); // 臨時 worktree 無法從父目錄刪掉
    const unlock = () => chmodSync(tempWorktreesDir("t-remove-fail"), 0o755);
    try {
      await expect(withTempWorktree("t-remove-fail", "slot-0", [], async () => {
        lockDir();
        return "結果";
      })).resolves.toBe("結果");
      unlock();
      await expect(withTempWorktree("t-remove-fail", "slot-1", [], async () => {
        lockDir();
        throw new Error("審查者自己的錯誤");
      })).rejects.toThrow("審查者自己的錯誤");
    } finally {
      unlock();
    }
    await cleanupTempWorktrees("t-remove-fail");
    expect(existsSync(tempWorktreesDir("t-remove-fail"))).toBe(false);
  });

  it("沒有臨時目錄時不執行 prune：別的 worktree 資料夾暫時不在，登記也不會被清掉", async () => {
    await setupRun("t-foreign");
    const foreign = join(root, "..", `${basename(root)}-foreign`);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", foreign, "HEAD"]);
    rmSync(foreign, { recursive: true, force: true }); // 例如放在尚未掛載的磁碟上
    await cleanupTempWorktrees("t-foreign");
    expect(listed()).toContain(`${basename(root)}-foreign`);
    execFileSync("git", ["-C", root, "worktree", "prune"]);
  });

  it("git 在建立途中被強制中止留下的 locked 登記（目錄還在或已不在）都能清掉，之後照常建立", async () => {
    await setupRun("t-locked");
    const kept = await createTempWorktree("t-locked", "slot-0", []);
    const gone = await createTempWorktree("t-locked", "slot-1", []);
    execFileSync("git", ["-C", root, "worktree", "lock", kept.dir]);
    execFileSync("git", ["-C", root, "worktree", "lock", gone.dir]);
    rmSync(gone.dir, { recursive: true, force: true });
    expect(listed()).toMatch(/^locked/m);
    await cleanupTempWorktrees("t-locked");
    expect(listed()).not.toContain(kept.dir);
    expect(listed()).not.toContain(gone.dir);
    expect(listed()).not.toMatch(/^locked/m);
    expect(existsSync(tempWorktreesDir("t-locked"))).toBe(false);
    const again = await createTempWorktree("t-locked", "slot-0", []);
    expect(listed()).toContain(again.dir);
    await removeTempWorktree("t-locked", again);
  });

  it("目錄已被刪掉時 removeTempWorktree 仍會讓 git 忘掉它", async () => {
    await setupRun("t-gone");
    const ws = await createTempWorktree("t-gone", "slot-0", []);
    rmSync(ws.dir, { recursive: true, force: true });
    await removeTempWorktree("t-gone", ws);
    expect(listed()).not.toContain(ws.dir);
  });

  it("複製 .flow 失敗時不留下臨時 worktree 與登記", async () => {
    if (process.getuid?.() === 0) return; // root 讀得到權限 000 的檔案，無法模擬複製失敗
    await setupRun("t-copy-fail");
    const unreadable = join(flowDir("t-copy-fail"), "secret.txt");
    writeFileSync(unreadable, "x");
    chmodSync(unreadable, 0o000);
    try {
      await expect(createTempWorktree("t-copy-fail", "slot-0", [])).rejects.toThrow();
    } finally {
      chmodSync(unreadable, 0o644);
    }
    expect(listed()).not.toContain(tempWorktreesDir("t-copy-fail"));
    expect(existsSync(tempWorktreesDir("t-copy-fail")) ? readdirSync(tempWorktreesDir("t-copy-fail")) : []).toEqual([]);
  });

  it("run worktree 有 node_modules 時臨時 worktree 以 symlink 讀得到，移除後原本的內容完好", async () => {
    await setupRun("t-deps");
    mkdirSync(join(worktreeDir("t-deps"), "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(worktreeDir("t-deps"), "node_modules", "pkg", "x.txt"), "依賴");
    let dir = "";
    await withTempWorktree("t-deps", "slot-0", ["node_modules"], async (ws) => {
      dir = ws.dir;
      expect(readFileSync(join(ws.dir, "node_modules", "pkg", "x.txt"), "utf8")).toBe("依賴");
    });
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(worktreeDir("t-deps"), "node_modules", "pkg", "x.txt"), "utf8")).toBe("依賴");
    // 中斷後由 cleanupTempWorktrees 收拾時也一樣不會刪到原本的 node_modules
    await createTempWorktree("t-deps", "slot-0", ["node_modules"]);
    await cleanupTempWorktrees("t-deps");
    expect(readFileSync(join(worktreeDir("t-deps"), "node_modules", "pkg", "x.txt"), "utf8")).toBe("依賴");
  });

  it("依 depDirs 建立 symlink，不寫死 node_modules", async () => {
    await setupRun("t-venv");
    mkdirSync(join(worktreeDir("t-venv"), ".venv"), { recursive: true });
    mkdirSync(join(worktreeDir("t-venv"), "node_modules"), { recursive: true });
    const ws = await createTempWorktree("t-venv", "slot-1", [".venv"]);
    try {
      expect(lstatSync(join(ws.dir, ".venv")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(ws.dir, "node_modules"))).toBe(false);
    } finally {
      await removeTempWorktree("t-venv", ws);
    }
  });

  it("run worktree 沒有 node_modules 時照常建立，也不會多出 node_modules", async () => {
    await setupRun("t-no-deps");
    await withTempWorktree("t-no-deps", "slot-0", [], async (ws) => {
      expect(existsSync(join(ws.dir, "node_modules"))).toBe(false);
    });
  });
});

describe("依賴目錄的目標已存在", () => {
  it("createTempWorktree 遇到已存在的目標（例如 .flow）略過，不丟例外", async () => {
    await setupRun("t-exists");
    const ws = await createTempWorktree("t-exists", "slot-0", [".flow"]);
    try {
      expect(lstatSync(join(ws.dir, ".flow")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(ws.flow, "spec.md"), "utf8")).toBe("# spec\n");
    } finally {
      await removeTempWorktree("t-exists", ws);
    }
  });

  it("createTempWorktree 不替一般檔案建 symlink", async () => {
    await setupRun("t-file");
    writeFileSync(join(worktreeDir("t-file"), ".env"), "SECRET=1\n");
    const ws = await createTempWorktree("t-file", "slot-0", [".env"]);
    try {
      expect(existsSync(join(ws.dir, ".env"))).toBe(false);
    } finally {
      await removeTempWorktree("t-file", ws);
    }
  });

  it("linkDepDirs 遇到已存在的目標略過，也不替一般檔案建 symlink", async () => {
    const from = mkdtempSync(join(tmpdir(), "agentflowctl-dep-from-"));
    const to = mkdtempSync(join(tmpdir(), "agentflowctl-dep-to-"));
    mkdirSync(join(from, ".venv"));
    mkdirSync(join(to, ".venv"));
    writeFileSync(join(from, ".env"), "SECRET=1\n");
    await expect(linkDepDirs(root, from, to, [".venv", ".env"])).resolves.toBeUndefined();
    expect(lstatSync(join(to, ".venv")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(to, ".env"))).toBe(false);
  });
});

describe("linkDepDirs", () => {
  it("只替存在的依賴目錄建 symlink，並寫入 exclude", async () => {
    const from = mkdtempSync(join(tmpdir(), "agentflowctl-dep-from-"));
    const to = mkdtempSync(join(tmpdir(), "agentflowctl-dep-to-"));
    mkdirSync(join(from, ".venv"));
    await linkDepDirs(root, from, to, [".venv", "target"]);
    expect(lstatSync(join(to, ".venv")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(to, "target"))).toBe(false);
    expect(existsSync(join(to, "node_modules"))).toBe(false);
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.venv");
    expect(exclude).toContain("/target");
  });
});
