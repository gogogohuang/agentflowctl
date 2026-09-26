import { describe, expect, it } from "vitest";
import { footerLine, headerLine, type LogEntry } from "./logs.js";
import type { FlowRun, HandoffIssue } from "./schemas.js";
import { stopReport } from "./stopReport.js";

const j = (o: unknown) => JSON.stringify(o);
const startedAt = "2026-09-26T03:00:00.000Z";
const endedAt = "2026-09-26T03:01:00.000Z";

const run = (over: Partial<FlowRun>): FlowRun => ({
  id: "f-1", baseBranch: "main", branch: "flow/f-1", requirement: "r", stage: "plan_review", autopilot: true,
  maxAgentRuns: 60, cycle: ["claude", "codex"], attempts: {}, taskIndex: 0, taskPhase: "tests",
  createdAt: startedAt, updatedAt: startedAt, ...over,
} as FlowRun);

const reply = [
  "改好了",
  "<result><status>done</status><summary>拆成 T-1～T-3</summary><files_changed><file>.flow/tasks.json</file></files_changed><concerns>T-2 可能太大</concerns></result>",
].join("\n");

const files: Record<string, string> = {
  "/l/001-plan_fix-plan-fix-claude.log": [
    headerLine({ stage: "plan_fix", step: "plan-fix", agent: "claude", adapter: "claude", startedAt }),
    j({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }),
    j({ type: "result", result: reply }),
    footerLine({ code: 0, ok: true, endedAt }),
  ].join("\n"),
  "/l/002-plan_review-plan-review-codex.log": headerLine({ stage: "plan_review", step: "plan-review", agent: "codex", adapter: "codex", startedAt }),
  "/l/003-verify-lint-cmd.log": [
    headerLine({ stage: "verify", step: "lint", agent: "cmd", startedAt }),
    "$ pnpm lint",
    "a.ts:1 no-unused-vars",
    footerLine({ code: 1, ok: false, endedAt }),
  ].join("\n"),
};
const entry = (seq: number, file: string, ended: boolean, ok = true): LogEntry => ({ seq, file, footer: ended ? { code: ok ? 0 : 1, ok, endedAt } : undefined });
const read = (f: string) => files[f]!;

const issue: HandoffIssue = {
  id: "abc123", kind: "action", summary: "V5 仍載入 v4 rsuite", evidence: "index.tsx", targetStage: "plan", status: "open",
  source: { stage: "plan_review", step: "plan-review", agent: "codex", callKey: "k" }, updatedAt: endedAt,
};

describe("run 停下時的結果與下一步", () => {
  it("Ctrl-C 中斷：標出進行中的步驟、上一步的結果、未結交接事項與 resume", () => {
    const out = stopReport({
      run: run({ stage: "plan_review" }), interrupted: true, worktree: "/wt", open: [issue], read,
      logs: [entry(1, "/l/001-plan_fix-plan-fix-claude.log", true), entry(2, "/l/002-plan_review-plan-review-codex.log", false)],
    }).join("\n");
    expect(out).toContain("中斷於 #2 plan_review / plan-review / codex");
    expect(out).toContain("#1 plan_fix / plan-fix / claude ✓");
    expect(out).toContain("摘要：拆成 T-1～T-3");
    expect(out).toContain("疑慮：T-2 可能太大");
    expect(out).toContain("[plan] abc123 V5 仍載入 v4 rsuite（open）");
    expect(out).toContain("agentflowctl resume f-1");
  });

  it("失敗：直接印出失敗步驟的錯誤與輸出，並列出查看、修正、接續的指令", () => {
    const out = stopReport({
      run: run({ stage: "failed", failedStage: "verify" }), worktree: "/wt", open: [], read,
      logs: [entry(1, "/l/001-plan_fix-plan-fix-claude.log", true), entry(3, "/l/003-verify-lint-cmd.log", true, false)],
    }).join("\n");
    expect(out).toContain("#3 verify / lint / cmd ✗");
    expect(out).toContain("a.ts:1 no-unused-vars");
    expect(out).toContain("結束碼 1");
    expect(out).toContain("agentflowctl logs f-1 3");
    expect(out).toContain("cd /wt");
    expect(out).toContain("agentflowctl resume f-1");
    expect(out).not.toContain("未結交接事項");
  });

  it("等待核准：下一步是檢視計畫與 approve；完成時不印任何東西", () => {
    const out = stopReport({ run: run({ stage: "awaiting_approval" }), worktree: "/wt", open: [], read, logs: [] }).join("\n");
    expect(out).toContain("/wt/.flow/plan.md");
    expect(out).toContain("agentflowctl approve f-1");
    expect(stopReport({ run: run({ stage: "done" }), worktree: "/wt", open: [issue], read, logs: [] })).toEqual([]);
  });
});
