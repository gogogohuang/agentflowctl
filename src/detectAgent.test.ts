import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-detect-agent-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
execFileSync("git", ["-C", root, "add", "Makefile"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

// 假 agent：把 proposal 寫進 .flow/detect-proposal.json（內容由 PROPOSAL 檔決定）
const agentScript = join(root, "fake-agent.mjs");
writeFileSync(agentScript, `import { copyFileSync, existsSync } from "node:fs";
if (existsSync("../../../quota.flag")) { console.error("usage limit reached"); process.exit(1); }
if (existsSync("../../../proposal.json")) copyFileSync("../../../proposal.json", ".flow/detect-proposal.json");
`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({
  agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"],
}));

const { addWorktree } = await import("./git.js");
const { detectWithAgent } = await import("./engine.js");
const { readDetected } = await import("./detectedFile.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { saveRun } = await import("./store.js");
const { resetQuotaState } = await import("./engine.js");
const { stageOfStep } = await import("./modelSelection.js");

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

describe("detectWithAgent", () => {
  it("未知類型：提案經驗證後寫入 detected.json，壞的欄位被丟掉並記錄原因", async () => {
    writeFileSync(join(root, "proposal.json"), JSON.stringify({
      install: "true", test: "sh -c 'exit 0'", checks: [{ name: "bad", cmd: "sh -c 'exit 1'" }],
    }));
    const run = await newRun("f-detect-1");
    await detectWithAgent(run);
    const saved = readDetected(root);
    // 沒有 testPattern 的 test 不走紅綠燈，改當一般檢查
    expect(saved?.test).toBeUndefined();
    expect(saved?.install).toBeUndefined();
    expect(saved?.checks).toEqual([{ name: "unit-tests", cmd: "sh -c 'exit 0'" }]);
    expect(saved?.dropped.map((d) => d.field).sort()).toEqual(["checks.bad", "install", "test"]);
  }, 30_000);

  it("指紋沒變時不再呼叫 agent", async () => {
    const run = await newRun("f-detect-2");
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
    expect(existsSync(join(flowDir("f-detect-2"), "detect-proposal.json"))).toBe(false);
  }, 30_000);

  it("adaptive 選模認得 detect 步驟", () => {
    expect(stageOfStep("detect")).toBe("spec");
  });

  it("額度用完：略過偵測、不寫 detected.json，也不找另一家代打", async () => {
    appendFileSync(join(root, "Makefile"), "# quota\n");
    writeFileSync(join(root, "quota.flag"), "1");
    const run = await newRun("f-detect-3");
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
    rmSync(join(root, "quota.flag"));
    resetQuotaState();
  }, 30_000);

  it("提案格式不合：只警告並記錄 dropped（proposal），不丟例外", async () => {
    appendFileSync(join(root, "Makefile"), "# bad-proposal\n");
    writeFileSync(join(root, "proposal.json"), JSON.stringify({ install: 123 }));
    const run = await newRun("f-detect-5");
    await expect(detectWithAgent(run)).resolves.toBeUndefined();
    expect(readDetected(root)?.dropped.map((d) => d.field)).toEqual(["proposal"]);
  }, 30_000);

  it("額度用完且有兩個 agent：被挑中的用完後，第二個不會被呼叫", async () => {
    // 兩個 agent 都先留下記號再回報額度用完；挑中哪一個都一樣，另一個不該被呼叫（detect 不代打）
    const script = (name: string) => {
      const path = join(root, `${name}-agent.mjs`);
      writeFileSync(path, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, `${name}-called.flag`))}, "1"); console.error("usage limit reached"); process.exit(1);\n`);
      return path;
    };
    const first = script("a2");
    const second = script("b2");
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: { a: { adapter: "command", command: ["node", first] }, b: { adapter: "command", command: ["node", second] } }, cycle: ["a", "b"],
    }));
    appendFileSync(join(root, "Makefile"), "# two-agents\n");
    const run = { ...(await newRun("f-detect-6")), cycle: ["a", "b"] };
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
    expect([existsSync(join(root, "a2-called.flag")), existsSync(join(root, "b2-called.flag"))].filter(Boolean)).toHaveLength(1);
    resetQuotaState();
  }, 30_000);

  it(".github/workflows 是檔案時不丟例外", async () => {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows"), "不是目錄");
    const run = await newRun("f-detect-7");
    await expect(detectWithAgent(run)).resolves.toBeUndefined();
  }, 30_000);

  it("flow.config.json 已手寫 install、test、checks、testPattern 時不呼叫 agent", async () => {
    rmSync(join(root, ".github"), { recursive: true, force: true });
    appendFileSync(join(root, "Makefile"), "# full-config\n");
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"],
      install: "true", test: "make test", checks: [], testPattern: "_spec\\.rb$",
    }));
    const run = await newRun("f-detect-8");
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
  }, 30_000);

  it("非預期錯誤只警告，不丟出也不寫指紋", async () => {
    appendFileSync(join(root, "Makefile"), "# boom\n");
    const run = { ...(await newRun("f-detect-4")), cycle: ["nope"] };
    const before = readDetected(root);
    await expect(detectWithAgent(run)).resolves.toBeUndefined();
    expect(readDetected(root)).toEqual(before);
  }, 30_000);
});
