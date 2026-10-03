import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-dump-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
process.chdir(root);
const { runDir, flowDir, projectRoot, worktreeDir } = await import("./paths.js");
const { getRun, saveRun } = await import("./store.js");
const { dumpRun, restoreRun } = await import("./dump.js");
const { addWorktree, removeWorktree } = await import("./git.js");

const now = new Date().toISOString();
const run = (id: string) => ({
  id, baseBranch: "main", branch: `flow/${id}`, requirement: "r", stage: "spec" as const, autopilot: false,
  maxAgentRuns: 10, cycle: ["claude", "codex"], attempts: {}, taskIndex: 0, taskPhase: "tests" as const, createdAt: now, updatedAt: now,
});

describe("dumpRun", () => {
  it("複製 run 資料、.flow 與設定，並寫出 meta.json", async () => {
    saveRun(run("d-a"));
    execFileSync("git", ["-C", root, "branch", "flow/d-a"]);
    mkdirSync(join(runDir("d-a"), "logs"), { recursive: true });
    writeFileSync(join(runDir("d-a"), "logs", "001-spec.log"), "log");
    writeFileSync(join(runDir("d-a"), "retries.jsonl"), "{}\n");
    mkdirSync(flowDir("d-a"), { recursive: true });
    writeFileSync(join(flowDir("d-a"), "spec.md"), "# spec");
    writeFileSync(join(projectRoot(), "flow.config.json"), '{"maxAttempts":4}');
    mkdirSync(join(projectRoot(), ".agentflowctl"), { recursive: true });
    writeFileSync(join(projectRoot(), ".agentflowctl", "detected.json"), '{"checks":[]}');

    const out = join(root, "out-a");
    await dumpRun("d-a", out);

    expect(readFileSync(join(out, "run", "logs", "001-spec.log"), "utf8")).toBe("log");
    expect(existsSync(join(out, "run", "state.json"))).toBe(true);
    expect(readFileSync(join(out, "flow", "spec.md"), "utf8")).toBe("# spec");
    expect(readFileSync(join(out, "flow.config.json"), "utf8")).toBe('{"maxAttempts":4}');
    expect(readFileSync(join(out, "detected.json"), "utf8")).toBe('{"checks":[]}');
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.runId).toBe("d-a");
    expect(meta.node).toBe(process.version);
    expect(meta.git.log).toContain("init");
  });

  it("缺檔不丟錯，記進 meta.json 的 missing", async () => {
    saveRun(run("d-b"));
    const out = join(root, "out-b");
    await dumpRun("d-b", out);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.missing).toEqual(expect.arrayContaining(["flow", "run/logs", "run/costs.jsonl"]));
    expect(existsSync(join(out, "run", "state.json"))).toBe(true);
  });

  it("收 replan 留下的 confirmations-restored 標記檔", async () => {
    saveRun(run("d-m"));
    mkdirSync(runDir("d-m"), { recursive: true });
    writeFileSync(join(runDir("d-m"), "confirmations-restored"), "");
    const out = join(root, "out-m");
    await dumpRun("d-m", out);
    expect(existsSync(join(out, "run", "confirmations-restored"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")).missing).not.toContain("run/confirmations-restored");
  });

  it("不收 parallel-review 與 tmp-review", async () => {
    saveRun(run("d-c"));
    for (const d of ["parallel-review", "tmp-review"]) {
      mkdirSync(join(runDir("d-c"), d), { recursive: true });
      writeFileSync(join(runDir("d-c"), d, "x"), "x");
    }
    const out = join(root, "out-c");
    await dumpRun("d-c", out);
    expect(existsSync(join(out, "run", "parallel-review"))).toBe(false);
    expect(existsSync(join(out, "run", "tmp-review"))).toBe(false);
  });
});

describe("restoreRun", () => {
  /** 建立 run、分支與 worktree 並 dump，再把 run 與 worktree 清掉，模擬在乾淨的環境復原 */
  async function dumped(id: string, opts: { keepBranch?: boolean } = {}): Promise<string> {
    saveRun({ ...run(id), stage: "plan_review" });
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(join(runDir(id), "logs"), { recursive: true });
    writeFileSync(join(runDir(id), "logs", "001-spec.log"), "log");
    writeFileSync(join(runDir(id), "confirmations.json"), "[]");
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "spec.md"), "# spec");
    const out = join(root, `restore-${id}`);
    await dumpRun(id, out);
    await removeWorktree(root, worktreeDir(id));
    rmSync(runDir(id), { recursive: true, force: true });
    if (opts.keepBranch === false) execFileSync("git", ["-C", root, "branch", "-D", `flow/${id}`]);
    return out;
  }

  it("還原 run 紀錄、.flow 與用既有分支重建 worktree，狀態原樣保留", async () => {
    const out = await dumped("r-a");
    const restored = await restoreRun(out);
    expect(restored.id).toBe("r-a");
    expect(getRun("r-a")?.stage).toBe("plan_review");
    expect(readFileSync(join(runDir("r-a"), "logs", "001-spec.log"), "utf8")).toBe("log");
    expect(readFileSync(join(flowDir("r-a"), "spec.md"), "utf8")).toBe("# spec");
    expect(execFileSync("git", ["-C", worktreeDir("r-a"), "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("flow/r-a");
  });

  it("標記檔跟著還原：確認資料的重建狀態不因復原而改變", async () => {
    const id = "r-m";
    saveRun({ ...run(id), stage: "plan_review" });
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    writeFileSync(join(runDir(id), "confirmations-restored"), "");
    mkdirSync(flowDir(id), { recursive: true });
    const out = join(root, `restore-${id}`);
    await dumpRun(id, out);
    await removeWorktree(root, worktreeDir(id));
    rmSync(runDir(id), { recursive: true, force: true });
    await restoreRun(out);
    expect(existsSync(join(runDir(id), "confirmations-restored"))).toBe(true);
  });

  it("不覆蓋專案現有的 flow.config.json", async () => {
    const out = await dumped("r-b");
    writeFileSync(join(projectRoot(), "flow.config.json"), '{"maxAttempts":9}');
    await restoreRun(out);
    expect(readFileSync(join(projectRoot(), "flow.config.json"), "utf8")).toBe('{"maxAttempts":9}');
  });

  it("run 已存在時拒絕，不動現有資料", async () => {
    const out = await dumped("r-c");
    saveRun(run("r-c"));
    await expect(restoreRun(out)).rejects.toThrow("已存在");
    expect(getRun("r-c")?.stage).toBe("spec");
  });

  it("分支不在時拒絕，也不留下半成品", async () => {
    const out = await dumped("r-d", { keepBranch: false });
    await expect(restoreRun(out)).rejects.toThrow("flow/r-d");
    expect(getRun("r-d")).toBeUndefined();
    expect(existsSync(runDir("r-d"))).toBe(false);
  });

  it("分支已在主專案簽出時拒絕並提示切換分支，也不留下半成品", async () => {
    const out = await dumped("r-e");
    execFileSync("git", ["-C", root, "switch", "flow/r-e"]);
    try {
      await expect(restoreRun(out)).rejects.toThrow("已在");
      expect(getRun("r-e")).toBeUndefined();
      expect(existsSync(runDir("r-e"))).toBe(false);
    } finally {
      execFileSync("git", ["-C", root, "switch", "main"]);
    }
  });

  it("不是 dump 目錄時丟錯", async () => {
    await expect(restoreRun(join(root, "not-a-dump"))).rejects.toThrow("dump");
  });
});
