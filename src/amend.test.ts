import { describe, expect, it } from "vitest";
import { decideAmend, nextId, type AmendInput } from "./amend.js";
import type { TaskItem } from "./schemas.js";

const task = (id: string, dependsOn: string[] = [], extra: Partial<TaskItem> = {}): TaskItem =>
  ({ id, title: `任務 ${id}`, description: `做 ${id}`, dependsOn, acceptance: ["AC-1"], ...extra });

const request = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ target: "T-1", reason: "回傳值要改成物件", files: ["src/a.ts"], acceptance: ["answer 為物件"], ...over });

const base = (over: Partial<AmendInput> = {}): AmendInput => ({
  raw: request(),
  requesterId: "T-2",
  tasks: [task("T-1"), task("T-2", ["T-1"])],
  done: new Set(["T-1"]),
  acceptance: [{ id: "AC-1", description: "既有條件" }],
  counts: {},
  max: 2,
  usedIds: [],
  ...over,
});

describe("decideAmend", () => {
  it("合格的請求插入修補任務，排在請求者之前，請求者改為依賴它", () => {
    const d = decideAmend(base());
    if (d.kind !== "apply") throw new Error(`預期 apply，實際 ${d.kind}`);
    expect(d.target).toBe("T-1");
    expect(d.task).toMatchObject({ id: "T-3", kind: "amend", amendOf: "T-1", dependsOn: ["T-1"], acceptance: ["AC-2"] });
    expect(d.task.description).toContain("回傳值要改成物件");
    expect(d.task.description).toContain("src/a.ts");
    expect(d.tasks.map((t) => t.id)).toEqual(["T-1", "T-3", "T-2"]);
    expect(d.tasks.find((t) => t.id === "T-2")?.dependsOn).toEqual(["T-1", "T-3"]);
    expect(d.acceptance).toEqual([{ id: "AC-1", description: "既有條件" }, { id: "AC-2", description: "answer 為物件" }]);
  });

  it("相同描述的驗收條件重用既有 AC id，不重複追加", () => {
    const d = decideAmend(base({ raw: request({ acceptance: ["既有條件"] }) }));
    if (d.kind !== "apply") throw new Error(d.kind);
    expect(d.task.acceptance).toEqual(["AC-1"]);
    expect(d.acceptance).toHaveLength(1);
  });

  it("新任務編號避開已用過的 id（含另存的確認任務）", () => {
    const d = decideAmend(base({ usedIds: ["T-7"] }));
    if (d.kind !== "apply") throw new Error(d.kind);
    expect(d.task.id).toBe("T-8");
  });

  it.each([
    ["不是 JSON", "not json", /JSON/],
    ["欄位不合格", request({ acceptance: [] }), /格式不正確/],
    ["target 是自己", request({ target: "T-2" }), /自己/],
    ["target 不存在", request({ target: "T-9" }), /找不到/],
    ["target 還沒合併", request({ target: "T-3" }), /還沒合併/],
  ])("無效請求：%s", (_name, raw, pattern) => {
    const tasks = [task("T-1"), task("T-2", ["T-1"]), task("T-3")];
    const d = decideAmend(base({ raw, tasks }));
    expect(d.kind).toBe("invalid");
    if (d.kind === "invalid") expect(d.reason).toMatch(pattern);
  });

  it("請求者不在任務清單裡時視為無效", () => {
    expect(decideAmend(base({ requesterId: "T-9" })).kind).toBe("invalid");
  });

  it("達到修補上限回報 limit", () => {
    const d = decideAmend(base({ counts: { "T-1": 2 } }));
    expect(d.kind).toBe("limit");
    if (d.kind === "limit") expect(d.reason).toMatch(/T-1.*2/);
  });

  it("同一個請求已經套用過就回報 applied（resume 冪等），而且優先於上限判斷", () => {
    const first = decideAmend(base());
    if (first.kind !== "apply") throw new Error(first.kind);
    const again = decideAmend(base({ tasks: first.tasks, acceptance: first.acceptance, counts: { "T-1": 2 } }));
    expect(again.kind).toBe("applied");
  });

  it("修補任務已合併後，同樣的請求視為新請求（計入次數，達上限回報 limit）", () => {
    const first = decideAmend(base());
    if (first.kind !== "apply") throw new Error(first.kind);
    const done = new Set(["T-1", first.task.id]);
    const again = decideAmend(base({ tasks: first.tasks, acceptance: first.acceptance, done, counts: { "T-1": 1 } }));
    expect(again.kind).toBe("apply");
    if (again.kind === "apply") expect(again.task.id).not.toBe(first.task.id);
    expect(decideAmend(base({ tasks: first.tasks, acceptance: first.acceptance, done, counts: { "T-1": 2 } })).kind).toBe("limit");
  });
});

describe("nextId", () => {
  it("取最大編號加一，沒有時從 1 開始", () => {
    expect(nextId("T", ["T-1", "T-10", "T-3"])).toBe("T-11");
    expect(nextId("AC", [])).toBe("AC-1");
    expect(nextId("AC", ["T-5", "AC-2"])).toBe("AC-3");
  });
});
