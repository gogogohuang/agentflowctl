import { describe, expect, it } from "vitest";
import { doneSet, readyTasks, scheduleLanes, type LaneOutcome } from "./lanes.js";
import type { TaskItem } from "./schemas.js";

const task = (id: string, dependsOn: string[] = [], extra: Partial<TaskItem> = {}): TaskItem =>
  ({ id, title: id, description: id, dependsOn, acceptance: ["AC-1"], ...extra }) as TaskItem;

const diamond = [task("T-1"), task("T-2", ["T-1"]), task("T-3", ["T-1"]), task("T-4", ["T-2", "T-3"])];

describe("可平行的任務", () => {
  it("沒有相依的任務一開始就能做，相依的要等前面都完成", () => {
    expect(readyTasks(diamond, new Set()).map((t) => t.id)).toEqual(["T-1"]);
    expect(readyTasks(diamond, new Set(["T-1"])).map((t) => t.id)).toEqual(["T-2", "T-3"]);
    expect(readyTasks(diamond, new Set(["T-1", "T-2"])).map((t) => t.id)).toEqual(["T-3"]);
    expect(readyTasks(diamond, new Set(["T-1", "T-2", "T-3"])).map((t) => t.id)).toEqual(["T-4"]);
  });

  it("正在執行的、人工確認的任務不會被選到；相依的 id 不在清單裡視同完成", () => {
    expect(readyTasks(diamond, new Set(["T-1"]), new Set(["T-2"])).map((t) => t.id)).toEqual(["T-3"]);
    expect(readyTasks([task("T-5", ["T-9"]), task("T-6", [], { kind: "confirm" })], new Set()).map((t) => t.id)).toEqual(["T-5"]);
  });

  it("doneSet 合併順序執行的進度與平行模式已合併的任務", () => {
    expect([...doneSet(diamond, 1, ["T-3"])].sort()).toEqual(["T-1", "T-3"]);
  });
});

describe("車道排程", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("相依鏈上的任務同時只跑一個，沒有相依的同時跑，合併後才解鎖下游", async () => {
    const log: string[] = [];
    let live = 0;
    let peak = 0;
    const result = await scheduleLanes(diamond, new Set(), Infinity, {
      async start(t) {
        log.push(`start ${t.id}`);
        peak = Math.max(peak, ++live);
        await tick();
        live--;
        return { kind: "done" };
      },
      async merge(t) {
        log.push(`merge ${t.id}`);
        return "merged";
      },
    });
    expect([...result.done].sort()).toEqual(["T-1", "T-2", "T-3", "T-4"]);
    expect(peak).toBe(2);
    expect(log.indexOf("merge T-1")).toBeLessThan(log.indexOf("start T-2"));
    expect(log.indexOf("merge T-2")).toBeLessThan(log.indexOf("start T-4"));
    expect(log.indexOf("merge T-3")).toBeLessThan(log.indexOf("start T-4"));
  });

  it("limit 限制同時執行的車道數", async () => {
    const tasks = [task("T-1"), task("T-2"), task("T-3"), task("T-4")];
    let live = 0;
    let peak = 0;
    await scheduleLanes(tasks, new Set(), 2, {
      async start() {
        peak = Math.max(peak, ++live);
        await tick();
        live--;
        return { kind: "done" };
      },
      merge: async () => "merged",
    });
    expect(peak).toBe(2);
  });

  it("limit 為 1 時依序一個一個跑", async () => {
    const order: string[] = [];
    await scheduleLanes([task("T-1"), task("T-2")], new Set(), 1, {
      async start(t) { order.push(t.id); await tick(); return { kind: "done" }; },
      merge: async () => "merged",
    });
    expect(order).toEqual(["T-1", "T-2"]);
  });

  it("合併一次一個：多條車道同時完成也依序合併", async () => {
    let merging = 0;
    let peak = 0;
    await scheduleLanes([task("T-1"), task("T-2"), task("T-3")], new Set(), Infinity, {
      start: async () => ({ kind: "done" }),
      async merge() { peak = Math.max(peak, ++merging); await tick(); merging--; return "merged"; },
    });
    expect(peak).toBe(1);
  });

  it("合併衝突時同一個任務重跑，之後才解鎖下游", async () => {
    const starts: string[] = [];
    let conflicts = 1;
    const result = await scheduleLanes([task("T-1"), task("T-2", ["T-1"])], new Set(), Infinity, {
      async start(t) { starts.push(t.id); return { kind: "done" }; },
      async merge(t) { return t.id === "T-1" && conflicts-- > 0 ? "redo" : "merged"; },
    });
    expect(starts).toEqual(["T-1", "T-1", "T-2"]);
    expect(result.done.has("T-2")).toBe(true);
  });

  it("衝突重試達上限時回報失敗，不再開新車道", async () => {
    const result = await scheduleLanes([task("T-1"), task("T-2", ["T-1"])], new Set(), Infinity, {
      start: async () => ({ kind: "done" }),
      merge: async () => ({ kind: "failed", reason: "合併衝突重試達上限", category: "retry_limit" }),
    });
    expect(result.failed?.task.id).toBe("T-1");
    expect(result.done.size).toBe(0);
  });

  it("有車道失敗就不再開新車道，但已在跑的跑完並合併", async () => {
    const started: string[] = [];
    const merged: string[] = [];
    const result = await scheduleLanes([task("T-1"), task("T-2"), task("T-3", ["T-1"])], new Set(), Infinity, {
      async start(t): Promise<LaneOutcome> {
        started.push(t.id);
        if (t.id === "T-1") return { kind: "failed", reason: "測試一直不過", category: "retry_limit" };
        await tick();
        await tick();
        return { kind: "done" };
      },
      async merge(t) { merged.push(t.id); return "merged"; },
    });
    expect(result.failed).toMatchObject({ reason: "測試一直不過", category: "retry_limit" });
    expect(result.failed?.task.id).toBe("T-1");
    expect(started).toEqual(["T-1", "T-2"]);
    expect(merged).toEqual(["T-2"]);
  });

  it("有車道暫停時也不再開新車道，回報暫停原因", async () => {
    const started: string[] = [];
    const result = await scheduleLanes([task("T-1"), task("T-2", ["T-1"])], new Set(), Infinity, {
      async start(t): Promise<LaneOutcome> { started.push(t.id); return { kind: "paused", reason: "claude 額度用完" }; },
      merge: async () => "merged",
    });
    expect(result.paused).toBe("claude 額度用完");
    expect(started).toEqual(["T-1"]);
  });

  it("起始就完成的任務不會重跑", async () => {
    const started: string[] = [];
    const result = await scheduleLanes(diamond, new Set(["T-1", "T-2"]), Infinity, {
      async start(t) { started.push(t.id); return { kind: "done" }; },
      merge: async () => "merged",
    });
    expect(started).toEqual(["T-3", "T-4"]);
    expect(result.done.size).toBe(4);
  });
});
