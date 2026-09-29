import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-parallel-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);

const { dropCall, loadCalls, openRound, runPool, saveCall, storedCallValid } = await import("./parallelReview.js");

const call = (key: string, reviewer = "a") => ({
  key, reviewer, agent: reviewer, step: "plan-review", callKey: `ck-${key}`, summary: "ok",
  output: JSON.stringify({ verdict: "approve", items: [] }), handoffResponse: null,
  base: { version: 1 as const, issues: [], appliedCalls: [] },
});

describe("runPool", () => {
  it("結果依輸入順序，與完成順序無關", async () => {
    const out = await runPool([30, 5, 15], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  it("同時執行數不超過上限", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    expect(peak).toBe(2);
  });

  it("上限為 Infinity 時全部同時執行", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3], Infinity, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    expect(peak).toBe(3);
  });

  it("有一個丟例外時其餘照常跑完，之後才丟出例外", async () => {
    const finished: number[] = [];
    await expect(runPool([0, 1, 2], 3, async (n) => {
      if (n === 0) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 30));
      finished.push(n);
    })).rejects.toThrow("boom");
    expect(finished.sort()).toEqual([1, 2]);
  });

  it("某項丟例外後，排隊中的項目仍會執行，最後丟出的是第一個例外", async () => {
    for (const limit of [1, 2]) {
      const started: number[] = [];
      await expect(runPool([0, 1, 2, 3, 4], limit, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, 5));
        if (n === 0) throw new Error("第一個");
        if (n === 2) throw new Error("第二個");
      })).rejects.toThrow("第一個");
      expect(started.sort()).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it("空清單回傳空陣列", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });
});

describe("審查結果存檔", () => {
  it("存了就讀得回來，依 key 索引", () => {
    const dir = openRound("p-save", "plan-review", "1:x");
    saveCall(dir, call("full:a"));
    saveCall(dir, call("full:b", "b"));
    const loaded = loadCalls(dir);
    expect([...loaded.keys()].sort()).toEqual(["full:a", "full:b"]);
    expect(loaded.get("full:b")?.reviewer).toBe("b");
  });

  it("同指紋再開一輪保留結果；換指紋就作廢舊的", () => {
    const first = openRound("p-fp", "plan-review", "1:x");
    saveCall(first, call("full:a"));
    expect(openRound("p-fp", "plan-review", "1:x")).toBe(first);
    expect(loadCalls(first).size).toBe(1);
    const second = openRound("p-fp", "plan-review", "1:y");
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(loadCalls(second).size).toBe(0);
  });

  it("不同 scope 互不影響", () => {
    const a = openRound("p-scope", "plan-review", "1:x");
    saveCall(a, call("full:a"));
    openRound("p-scope", "review", "other");
    expect(loadCalls(a).size).toBe(1);
  });

  it("損毀或不合格式的檔案被刪掉並略過", () => {
    const dir = openRound("p-bad", "plan-review", "1:x");
    saveCall(dir, call("full:a"));
    writeFileSync(join(dir, "壞掉.json"), "{ 不是 json");
    writeFileSync(join(dir, "缺欄位.json"), JSON.stringify({ key: "x" }));
    const loaded = loadCalls(dir);
    expect([...loaded.keys()]).toEqual(["full:a"]);
    expect(readdirSync(dir).sort()).toHaveLength(1);
  });

  it("寫到一半留下的 .tmp 會被刪掉", () => {
    const dir = openRound("p-tmp", "plan-review", "1:x");
    saveCall(dir, call("full:a"));
    writeFileSync(join(dir, "半成品.json.tmp"), "{ \"key\":");
    expect([...loadCalls(dir).keys()]).toEqual(["full:a"]);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("缺少 base 的舊格式存檔視為損毀，刪掉重跑", () => {
    const dir = openRound("p-no-base", "plan-review", "1:x");
    const { base: _base, ...old } = call("full:a");
    writeFileSync(join(dir, "old.json"), JSON.stringify(old));
    expect(loadCalls(dir).size).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dropCall 刪掉指定的結果，不存在時不出錯", () => {
    const dir = openRound("p-drop", "plan-review", "1:x");
    saveCall(dir, call("full:a"));
    dropCall(dir, "full:a");
    dropCall(dir, "full:不存在");
    expect(loadCalls(dir).size).toBe(0);
  });

  it("寫入是原子的，不留下 .tmp 檔", () => {
    const dir = openRound("p-atomic", "plan-review", "1:x");
    saveCall(dir, call("full:a"));
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("存檔有效性", () => {
  const ledger = (appliedCalls: string[]) => ({ version: 1 as const, issues: [], appliedCalls });
  const stored = (key: string, applied: string[]) => ({ ...call(key), base: ledger(applied) });

  it("帳本沒變，或只多了本輪已存檔審查者的呼叫（崩潰前已套用）時仍可沿用", () => {
    const round = [stored("full:a", ["spec"]), stored("full:b", ["spec"])];
    expect(storedCallValid(round[1]!, ledger(["spec"]), round)).toBe(true);
    expect(storedCallValid(round[1]!, ledger(["spec", "ck-full:a"]), round)).toBe(true);
  });

  it("帳本多了本輪以外的呼叫（例如修正者）時作廢", () => {
    const round = [stored("full:a", ["spec"]), stored("full:b", ["spec"])];
    expect(storedCallValid(round[0]!, ledger(["spec", "ck-full:b", "plan-fix"]), round)).toBe(false);
  });

  it("重跑的呼叫看到的帳本較新，以它自己的 base 判斷", () => {
    const round = [stored("full:a", ["spec"]), stored("full:b", ["spec", "ck-full:a"])];
    expect(storedCallValid(round[1]!, ledger(["spec", "ck-full:a"]), round)).toBe(true);
  });
});
