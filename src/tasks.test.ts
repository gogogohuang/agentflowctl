import { describe, expect, it } from "vitest";
import { TaskItem } from "./schemas.js";
import { orderTasks } from "./tasks.js";

const task = (id: string, dependsOn: string[] = [], acceptance = ["AC-1"]) =>
  TaskItem.parse({ id, title: id, description: id, dependsOn, acceptance });

describe("orderTasks", () => {
  it("依相依關係排序", () => {
    const r = orderTasks([task("T-3", ["T-2"]), task("T-1"), task("T-2", ["T-1"])], new Set(["AC-1"]));
    expect(Array.isArray(r) && r.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("偵測循環相依", () => {
    const r = orderTasks([task("T-1", ["T-2"]), task("T-2", ["T-1"])], new Set(["AC-1"]));
    expect(r).toContain("循環相依");
  });

  it("偵測不存在的相依與驗收條件", () => {
    const r = orderTasks([task("T-1", ["T-9"], ["AC-7"])], new Set(["AC-1"]));
    expect(r).toContain("T-9 不存在");
    expect(r).toContain("AC-7 不存在");
    expect(r).toContain("AC-1 沒有任何任務負責");
  });

  it("偵測重複 id", () => {
    expect(orderTasks([task("T-1"), task("T-1")], new Set(["AC-1"]))).toContain("重複");
  });

  it("一個任務最多對應兩條驗收條件", () => {
    const acs = new Set(["AC-1", "AC-2", "AC-3"]);
    expect(Array.isArray(orderTasks([task("T-1", [], ["AC-1", "AC-2"]), task("T-2", [], ["AC-3"])], acs))).toBe(true);
    expect(orderTasks([task("T-1", [], ["AC-1", "AC-2", "AC-3"])], acs)).toContain("T-1 對應 3 條驗收條件");
  });
});
