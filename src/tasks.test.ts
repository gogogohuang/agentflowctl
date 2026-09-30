import { describe, expect, it } from "vitest";
import { TaskItem } from "./schemas.js";
import { confirmationLines, confirmationTasks, orderTasks, taskAcceptance, validateTaskComplexity, validateTddFlag } from "./tasks.js";

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

describe("taskAcceptance", () => {
  const acceptance = [
    { id: "AC-1", description: "建立資料" },
    { id: "AC-2", description: "顯示錯誤" },
    { id: "AC-3", description: "記錄事件" },
  ];

  it("只提供目前任務的驗收條件，且維持任務指定的順序", () => {
    expect(taskAcceptance(task("T-2", [], ["AC-3", "AC-1"]), acceptance)).toEqual([
      { id: "AC-3", description: "記錄事件" },
      { id: "AC-1", description: "建立資料" },
    ]);
  });

  it("驗收條件在計畫通過後遺失時明確失敗", () => {
    expect(() => taskAcceptance(task("T-2", [], ["AC-9"]), acceptance)).toThrow("AC-9 不存在");
  });
});

describe("任務難度", () => {
  it("adaptive 必須逐任務標註，balanced 允許舊任務缺少標註", () => {
    const without = [task("T-1")];
    expect(validateTaskComplexity(without, "adaptive")).toContain("T-1");
    expect(validateTaskComplexity(without, "balanced")).toBeUndefined();
    expect(validateTaskComplexity([TaskItem.parse({ ...without[0], complexity: "high" })], "adaptive")).toBeUndefined();
  });
});

describe("TaskItem.tdd", () => {
  it("tdd 是選填欄位，沒寫視為要走 TDD", () => {
    const base = { id: "T-1", title: "a", description: "a", acceptance: ["AC-1"] };
    expect(TaskItem.parse(base).tdd).toBeUndefined();
    expect(TaskItem.parse({ ...base, tdd: false }).tdd).toBe(false);
    expect(TaskItem.safeParse({ ...base, tdd: "no" }).success).toBe(false);
  });

  it("描述寫明不要求紅燈時，tdd 必須是 false", () => {
    const description = "擴充 scripts/check-bundle-size.test.ts。此為特徵化測試，可能一開始即通過，不要求紅燈。";
    const conflict = TaskItem.parse({ id: "T-12", title: "空 chunks", description, acceptance: ["AC-1"], tdd: true });
    const omitted = TaskItem.parse({ id: "T-12", title: "空 chunks", description, acceptance: ["AC-1"] });
    const waived = TaskItem.parse({ id: "T-12", title: "空 chunks", description, acceptance: ["AC-1"], tdd: false });
    expect(validateTddFlag([conflict])).toContain("T-12");
    expect(validateTddFlag([omitted])).toContain("tdd");
    expect(validateTddFlag([waived])).toBeUndefined();
    expect(validateTddFlag([task("T-1")])).toBeUndefined();
  });
});

describe("待人確認的任務", () => {
  const confirm = TaskItem.parse({ id: "T-18", title: "核對畫面", description: "人眼看過首頁", acceptance: ["AC-32"], kind: "confirm" });
  const implement = task("T-1");

  it("已寫出確認清單時以它為準，空陣列就是沒有", () => {
    expect(confirmationTasks([confirm], [implement], [])).toEqual([confirm]);
    expect(confirmationTasks([], [confirm], [confirm])).toEqual([]);
  });

  it("還沒寫出確認清單時，從實作清單與計畫蒐集，並去掉重複", () => {
    expect(confirmationTasks(undefined, [implement, confirm], [confirm])).toEqual([confirm]);
    expect(confirmationTasks(undefined, [implement], [])).toEqual([]);
  });

  it("列印時只含待確認任務，沒有時說明沒有", () => {
    const lines = confirmationLines([confirm]).join("\n");
    expect(lines).toContain("待你確認（不進實作）");
    expect(lines).toContain("T-18 核對畫面");
    expect(lines).toContain("人眼看過首頁");
    expect(lines).toContain("驗收：AC-32");
    expect(confirmationLines([])).toEqual(["沒有需要人確認的任務"]);
  });

  it("draft 為 true 時標示計畫尚未定案", () => {
    const lines = confirmationLines([confirm], true).join("\n");
    expect(lines).toContain("待你確認（不進實作）");
    expect(lines).toContain("計畫尚未定案");
    expect(confirmationLines([confirm], false).join("\n")).not.toContain("計畫尚未定案");
  });
});
