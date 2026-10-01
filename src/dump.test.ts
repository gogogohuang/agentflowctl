import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-dump-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"]);
process.chdir(root);
const { runDir, flowDir, projectRoot } = await import("./paths.js");
const { saveRun } = await import("./store.js");
const { dumpRun } = await import("./dump.js");

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

    const out = join(root, "out-a");
    await dumpRun("d-a", out);

    expect(readFileSync(join(out, "run", "logs", "001-spec.log"), "utf8")).toBe("log");
    expect(existsSync(join(out, "run", "state.json"))).toBe(true);
    expect(readFileSync(join(out, "flow", "spec.md"), "utf8")).toBe("# spec");
    expect(readFileSync(join(out, "flow.config.json"), "utf8")).toBe('{"maxAttempts":4}');
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
