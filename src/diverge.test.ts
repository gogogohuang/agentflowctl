import { describe, expect, it } from "vitest";
import { consecutiveEligible, divergeExclude, divergeStamp, formatDivergeFeedback, selectFrames, shouldDiverge } from "./diverge.js";

const retry = (key: string, category: string) => ({ key, category });

describe("shouldDiverge", () => {
  const base = {
    enabled: true, after: 2, phase: "code" as const, taskId: "T-1",
    attempts: { "T-1:code": 2 }, testsRedos: 0, lastStamp: undefined as string | undefined, since: 0,
    retries: [retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_not_green")],
  };

  it("關閉、第一次失敗、不合格分類、tests_not_red 都不觸發", () => {
    expect(shouldDiverge({ ...base, enabled: false })).toBe(false);
    expect(shouldDiverge({ ...base, attempts: { "T-1:code": 1 }, retries: [retry("T-1:code", "tests_not_green")] })).toBe(false);
    expect(shouldDiverge({ ...base, retries: [retry("T-1:code", "handoff_invalid")] })).toBe(false);
    expect(shouldDiverge({ ...base, retries: [retry("T-1:code", "tests_not_red"), retry("T-1:code", "tests_not_red")] })).toBe(false);
  });

  it("同一 key 最近連續合格剛好 after 筆時觸發，再多一筆合格不再觸發", () => {
    expect(shouldDiverge(base)).toBe(true);
    expect(shouldDiverge({
      ...base, attempts: { "T-1:code": 3 },
      retries: [...base.retries, retry("T-1:code", "tests_not_green")],
    })).toBe(false);
  });

  it("中間插入不合格會重算連續，不會因為 attempts 已超過 after 就永遠不發散", () => {
    expect(shouldDiverge({
      ...base, attempts: { "T-1:code": 2 },
      retries: [retry("T-1:code", "tests_not_green"), retry("T-1:code", "handoff_invalid")],
    })).toBe(false);
    expect(shouldDiverge({
      ...base, attempts: { "T-1:code": 3 },
      retries: [retry("T-1:code", "handoff_invalid"), retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_not_green")],
    })).toBe(true);
  });

  it("綠燈退回測試時，tests 階段也觸發；tests 已自己失敗過就不再用這條", () => {
    const back = { ...base, phase: "tests" as const, attempts: {}, testsRedos: 1, retries: [retry("T-1:code", "tests_invalid")] };
    expect(shouldDiverge(back)).toBe(true);
    expect(shouldDiverge({ ...back, attempts: { "T-1:tests": 1 } })).toBe(false);
  });

  it("退回測試發散過之後，code 階段不會因為舊的連續失敗再發散（真實序列：綠燈失敗一次，再退回測試）", () => {
    const retries = [retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_invalid")];
    // 退回測試發散時記下 retriesSeen = 2；回到 code 階段時 attempts 已被 redoTests 清掉
    expect(shouldDiverge({ ...base, retries, attempts: {}, testsRedos: 1, since: 0 })).toBe(true);
    expect(shouldDiverge({ ...base, retries, attempts: {}, testsRedos: 1, since: 2 })).toBe(false);
    // 發散之後又新增兩筆合格失敗才會再觸發
    expect(shouldDiverge({
      ...base, attempts: { "T-1:code": 2 }, testsRedos: 1, since: 2,
      retries: [...retries, retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_not_green")],
    })).toBe(true);
  });

  it("已有相同 stamp 時不重跑", () => {
    const stamp = divergeStamp("T-1", "code", 2, 0);
    expect(shouldDiverge({ ...base, lastStamp: stamp })).toBe(false);
  });
});

describe("consecutiveEligible", () => {
  it("since 之前的筆數不算", () => {
    const rows = [retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_not_green"), retry("T-1:code", "tests_not_green")];
    expect(consecutiveEligible(rows, "T-1:code")).toBe(3);
    expect(consecutiveEligible(rows, "T-1:code", 2)).toBe(1);
  });

  it("略過其他 key，不合格分類中斷", () => {
    expect(consecutiveEligible([
      retry("T-1:code", "tests_not_green"), retry("T-1:tests", "tests_not_written"), retry("T-1:code", "tests_not_green"),
    ], "T-1:code")).toBe(2);
    expect(consecutiveEligible([
      retry("T-1:code", "tests_not_green"), retry("T-1:code", "agent_error"), retry("T-1:code", "tests_not_green"),
    ], "T-1:code")).toBe(1);
  });
});

describe("divergeExclude", () => {
  it("退回測試或綠燈排除實作者，紅燈連續失敗排除測試作者", () => {
    expect(divergeExclude({ phase: "tests", testsRedos: 1, lastWriter: "b", testsAgent: "a", codeAgent: "b" })).toBe("b");
    expect(divergeExclude({ phase: "tests", testsRedos: 1, testsAgent: "a", codeAgent: "b" })).toBe("b");
    expect(divergeExclude({ phase: "code", testsAgent: "a", codeAgent: "b" })).toBe("b");
    expect(divergeExclude({ phase: "tests", testsRedos: 0, lastTestsAuthor: "a", testsAgent: "a", codeAgent: "b" })).toBe("a");
  });
});

describe("selectFrames", () => {
  it("同一個 seed 永遠得到同樣的順序，數量為 2 或 3", () => {
    expect(selectFrames("run-a:T-1:code:2", 3)).toEqual(selectFrames("run-a:T-1:code:2", 3));
    expect(selectFrames("run-a:T-1:code:2", 3)).toHaveLength(3);
    expect(selectFrames("run-a:T-1:code:2", 2)).toHaveLength(2);
    expect(new Set(selectFrames("x", 3))).toEqual(new Set(["acceptance", "split", "invert"]));
  });
});

describe("formatDivergeFeedback", () => {
  it("寫出評審選的 frame、建議與下一動", () => {
    const text = formatDivergeFeedback({
      pick: "invert", action: "rewrite_tests", rationale: "斷言互相矛盾", nextStep: "重寫 T-1 測試，對照 AC-2",
    });
    expect(text).toContain("## 發散結論");
    expect(text).toContain("invert");
    expect(text).toContain("rewrite_tests");
    expect(text).toContain("重寫 T-1 測試，對照 AC-2");
  });
});
