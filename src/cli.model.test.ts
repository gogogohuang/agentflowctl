import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "src", "cli.ts");
const tsx = createRequire(import.meta.url).resolve("tsx");

describe("model CLI", () => {
  it.each(["codex", "gemini"] as const)("%s 新增與重驗使用隔離短請求，失敗不寫設定", (adapter) => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-model-cli-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    execFileSync("git", ["init", "-q", root]);
    const config = join(root, "flow.config.json");
    const captured = join(root, "captured.json");
    const fake = join(bin, adapter);
    writeFileSync(config, JSON.stringify({ agents: { local: { adapter, extraArgs: ["--yolo"] } } }));
    const events = adapter === "codex"
      ? [{ type: "item.completed", item: { type: "agent_message", text: "OK" } }, { type: "turn.completed", usage: {} }]
      : [{ type: "init", model: "actual-id" }, { type: "message", role: "assistant", content: "OK" }, { type: "result", status: "success" }];
    const emit = (lines: unknown[]) => writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));
      ${lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join("\n")}`, { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, "model", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    try {
      emit(events);
      const added = run("add", "local", "model-x", "--strength", "medium");
      expect(added.status, added.stderr).toBe(0);
      expect(JSON.parse(readFileSync(config, "utf8")).agents.local.models).toEqual([{ name: "model-x", strength: "medium" }]);
      const invocation = JSON.parse(readFileSync(captured, "utf8"));
      expect(invocation.cwd).not.toBe(root);
      expect(existsSync(invocation.cwd)).toBe(false);
      expect(invocation.args).toContain("model-x");
      expect(invocation.args).not.toContain("--yolo");
      const before = readFileSync(config, "utf8");
      expect(run("check", "local").status).toBe(0);
      expect(readFileSync(config, "utf8")).toBe(before);
      emit([{ type: "error", message: "invalid model" }]);
      expect(run("add", "local", "bad-model", "--strength", "high").status).toBe(1);
      const checked = run("check", "local");
      expect(checked.stdout).toContain("❌");
      expect(checked.stdout).not.toContain("可呼叫");
      expect(readFileSync(config, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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
  }, 30_000);

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

  it.each(["plan_review", "later"])("run 在建立 worktree 前拒絕非法停點 %s", (stopAfter) => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-stop-cli-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: { local: { adapter: "command", command: [process.execPath, "-e", "console.log('ok')"] } },
      cycle: ["local"],
    }));
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "run", "--req", "測試", "--stop-after", stopAfter], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("停點");
    expect(existsSync(join(root, ".agentflowctl", "worktrees"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("run 同時使用 manual-plan 與 stop-after 時，在建立 worktree 前拒絕", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-stop-cli-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: { local: { adapter: "command", command: [process.execPath, "-e", "console.log('ok')"] } },
      cycle: ["local"],
    }));
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "run", "--req", "測試", "--manual-plan", "--stop-after", "plan"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("不能同時");
    expect(existsSync(join(root, ".agentflowctl", "worktrees"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("run 接受公開停點並把 stopAfter 寫入新 run", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflowctl-stop-cli-"));
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["-C", root, "add", "base.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
    const agent = join(root, "agent.mjs");
    writeFileSync(agent, `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(".flow", { recursive: true });
writeFileSync(".flow/spec.md", "# 規格\\n");
writeFileSync(".flow/acceptance.json", JSON.stringify([{ id: "AC-1", description: "完成" }]));
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: { local: { adapter: "command", command: [process.execPath, agent] } },
      cycle: ["local"], install: "true",
    }));
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "run", "--req", "測試", "--stop-after", "spec"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const runId = result.stdout.match(/run\s+(f-[^\s]+)/)?.[1];
    expect(runId).toBeDefined();
    const state = JSON.parse(readFileSync(join(root, ".agentflowctl", "runs", runId!, "state.json"), "utf8"));
    expect(state).toMatchObject({ stage: "paused", stopAfter: "spec", pausedStage: "plan" });
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
