import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-parallel-"));
execFileSync("git", ["init", "-q", root]);
process.chdir(root);

const { dropCall, loadCalls, openRound, runPool, saveCall } = await import("./parallelReview.js");

const call = (key: string, reviewer = "a") => ({
  key, reviewer, agent: reviewer, step: "plan-review", callKey: `ck-${key}`, summary: "ok",
  output: JSON.stringify({ verdict: "approve", items: [] }), handoffResponse: null,
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
