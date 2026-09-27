import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "src", "cli.ts");
const tsx = createRequire(import.meta.url).resolve("tsx");

describe("model CLI", () => {
  it("探測成功才新增模型；名稱不符時設定保持原狀", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-model-cli-"));
    execFileSync("git", ["init", "-q", root]);
    const probe = join(root, "probe.cjs");
    const config = join(root, "flow.config.json");
    writeFileSync(probe, "console.log(JSON.stringify({requestedModel:process.argv[2],resolvedModel:'actual-id'}))");
    writeFileSync(config, JSON.stringify({ agents: { local: { adapter: "command", command: ["custom", "{model}"], modelProbe: [process.execPath, probe, "{model}"] } } }));
    const success = spawnSync(process.execPath, ["--import", tsx, cli, "model", "add", "local", "alias", "--strength", "low"], { cwd: root, encoding: "utf8" });
    expect(success.status, success.stderr).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8")).agents.local.models).toEqual([{ name: "alias", strength: "low" }]);
    const marker = join(root, "duplicate-probed");
    writeFileSync(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'probed')`);
    const duplicate = spawnSync(process.execPath, ["--import", tsx, cli, "model", "add", "local", "alias", "--strength", "high"], { cwd: root, encoding: "utf8" });
    expect(duplicate.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const before = readFileSync(config, "utf8");
    writeFileSync(probe, "console.log(JSON.stringify({requestedModel:'wrong',resolvedModel:'actual-id'}))");
    const failed = spawnSync(process.execPath, ["--import", tsx, cli, "model", "add", "local", "another", "--strength", "high"], { cwd: root, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(readFileSync(config, "utf8")).toBe(before);

    const stage = spawnSync(process.execPath, ["--import", tsx, cli, "model", "stage", "taskReview", "high"], { cwd: root, encoding: "utf8" });
    expect(stage.status, stage.stderr).toBe(0);
    const mode = spawnSync(process.execPath, ["--import", tsx, cli, "model", "mode", "adaptive"], { cwd: root, encoding: "utf8" });
    expect(mode.status, mode.stderr).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8")).modelSelection).toEqual({ stageStrength: { taskReview: "high" }, mode: "adaptive" });
    const set = spawnSync(process.execPath, ["--import", tsx, cli, "model", "set", "local", "alias", "--strength", "medium"], { cwd: root, encoding: "utf8" });
    expect(set.status, set.stderr).toBe(0);
    const list = spawnSync(process.execPath, ["--import", tsx, cli, "model", "list", "local"], { cwd: root, encoding: "utf8" });
    expect(list.stdout).toContain("alias  medium");
    writeFileSync(probe, "console.log(JSON.stringify({requestedModel:process.argv[2],resolvedModel:'actual-id'}))");
    const check = spawnSync(process.execPath, ["--import", tsx, cli, "model", "check", "local"], { cwd: root, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("alias: 可呼叫 → actual-id");
    const blocked = spawnSync(process.execPath, ["--import", tsx, cli, "model", "remove", "local", "alias"], { cwd: root, encoding: "utf8" });
    expect(blocked.status).toBe(1);
    expect(JSON.parse(readFileSync(config, "utf8")).agents.local.models).toEqual([{ name: "alias", strength: "medium" }]);
  });

  it("run 在建立 worktree 前拒絕缺模型的 adaptive 設定", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-model-run-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    const config = join(root, "flow.config.json");
    writeFileSync(config, JSON.stringify({ agents: { local: { adapter: "command", command: [process.execPath, "-e", "console.log('ok')"] } }, cycle: ["local"] }));
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "run", "--req", "測試", "--model-mode", "adaptive"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("models");
    expect(existsSync(join(root, ".agentflowctl", "worktrees"))).toBe(false);
  });

  it("resume 前重新檢查 adaptive 設定，缺模型時不接續也不改狀態", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-model-resume-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({ agents: { local: { adapter: "command", command: ["custom", "{model}"] } }, cycle: ["local"] }));
    const runDir = join(root, ".agentflowctl", "runs", "f-old");
    mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    const state = JSON.stringify({ id: "f-old", baseBranch: "main", branch: "flow/f-old", requirement: "測試", stage: "paused", pausedStage: "spec",
      autopilot: true, maxAgentRuns: 10, cycle: ["local"], attempts: {}, modelMode: "adaptive", taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now });
    writeFileSync(join(runDir, "state.json"), state);
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "resume", "f-old"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("models");
    expect(readFileSync(join(runDir, "state.json"), "utf8")).toBe(state);
  });
});
