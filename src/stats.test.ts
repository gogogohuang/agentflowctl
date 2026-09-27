import { describe, expect, it } from "vitest";
import type { LogEntry } from "./logs.js";
import { computeStats, formatDuration } from "./stats.js";

let seq = 0;
const entry = (step: string, agent: string, start: string, end?: string, ok = true): LogEntry => ({
  seq: ++seq,
  file: `${seq}.log`,
  header: { stage: "implement", step, agent, startedAt: `2026-09-27T10:${start}Z` },
  footer: end ? { code: ok ? 0 : 1, ok, endedAt: `2026-09-27T10:${end}Z` } : undefined,
});

describe("computeStats", () => {
  it("依步驟加總次數、失敗與耗時，最耗時的排前面", () => {
    const { steps } = computeStats([
      entry("T-1-tests", "claude", "00:00", "02:00"),
      entry("T-1-red", "cmd", "02:00", "02:10"),
      entry("T-1-tests", "codex", "03:00", "07:00", false),
      entry("T-1-red", "cmd", "07:00", "07:20"),
    ]);
    expect(steps).toEqual([
      { step: "T-1-tests", kind: "agent", runs: 2, failed: 1, unfinished: 0, totalMs: 360_000, maxMs: 240_000 },
      { step: "T-1-red", kind: "cmd", runs: 2, failed: 0, unfinished: 0, totalMs: 30_000, maxMs: 20_000 },
    ]);
  });

  it("分開加總 agent 與專案指令的耗時，沒有檔尾的算未完成", () => {
    const stats = computeStats([
      entry("spec", "claude", "00:00", "01:00"),
      entry("verify-test", "cmd", "01:00", "01:30"),
      entry("plan", "codex", "05:00"),
    ]);
    expect(stats).toMatchObject({ agentMs: 60_000, cmdMs: 30_000, wallMs: 90_000, unfinished: 1 });
    expect(stats.steps.find((s) => s.step === "plan")).toMatchObject({ runs: 1, unfinished: 1, totalMs: 0 });
  });
});

describe("formatDuration", () => {
  it("依長度顯示秒、分秒或時分", () => {
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m05s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});
