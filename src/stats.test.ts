import { describe, expect, it } from "vitest";
import type { LogEntry } from "./logs.js";
import { computeStats, formatDuration, mergeStats } from "./stats.js";

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
      entry("T-1-red", "cmd", "02:00", "02:10", false),
      entry("T-1-tests", "codex", "03:00", "07:00", false),
      entry("T-1-red", "cmd", "07:00", "07:20", false),
    ]);
    expect(steps).toEqual([
      { step: "T-1-tests", kind: "agent", runs: 2, failed: 1, unfinished: 0, totalMs: 360_000, maxMs: 240_000 },
      { step: "T-1-red", kind: "cmd", runs: 2, failed: 0, unfinished: 0, totalMs: 30_000, maxMs: 20_000 },
    ]);
  });

  it("紅燈指令失敗是預期結果，測試意外通過才算失敗", () => {
    const { steps } = computeStats([
      entry("T-1-red", "cmd", "00:00", "00:10", false),
      entry("T-1-red", "cmd", "01:00", "01:10", false),
      entry("T-1-red", "cmd", "02:00", "02:10", true),
      entry("T-1-green", "cmd", "03:00", "03:10", false),
    ]);
    expect(steps.find((s) => s.step === "T-1-red")).toMatchObject({ runs: 3, failed: 1 });
    expect(steps.find((s) => s.step === "T-1-green")).toMatchObject({ runs: 1, failed: 1 });
  });

  it("agent 步驟即使名稱含 red 也照一般規則", () => {
    const { steps } = computeStats([entry("T-1-red", "claude", "00:00", "00:10", false)]);
    expect(steps[0]).toMatchObject({ kind: "agent", failed: 1 });
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

describe("mergeStats", () => {
  it("跨 run 合併次數與失敗，不計算總經過時間", () => {
    const a = computeStats([
      entry("T-1-tests", "claude", "00:00", "02:00", false),
      entry("lint", "cmd", "02:00", "02:10"),
    ]);
    const b = computeStats([
      entry("T-3-tests", "codex", "00:00", "01:00", false),
      entry("T-3-tests", "codex", "01:00", "01:30"),
    ]);
    const merged = mergeStats([a, b]);
    expect("wallMs" in merged).toBe(false);
    // task id 只在同一個 run 內有意義，跨 run 依步驟種類合併
    expect(merged.steps.find((s) => s.step === "任務:tests")).toMatchObject({
      kind: "agent", runs: 3, failed: 2, unfinished: 0,
    });
    expect(merged.steps.some((s) => s.step.startsWith("T-"))).toBe(false);
    expect(merged.steps[0]?.step).toBe("任務:tests");
    expect(merged.unfinished).toBe(0);
  });

  it("沒有 run 時全部為 0", () => {
    expect(mergeStats([])).toEqual({ steps: [], agentMs: 0, cmdMs: 0, unfinished: 0 });
  });
});

describe("formatDuration", () => {
  it("依長度顯示秒、分秒或時分", () => {
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m05s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
  });
});
