import { describe, expect, it } from "vitest";
import type { AcceptanceItem, TaskItem } from "./schemas.js";
import {
  applyReviewVerdicts,
  dirtyGroups,
  dirtyTaskIds,
  extractFiles,
  extractPlanEvidence,
  groupReviewerCount,
  layeredReview,
  missingTaskHeadings,
  neighborTasks,
  planContentKey,
  planOverview,
  planReviewGroups,
  planReviewIndex,
  readPendingArbitration,
  readPlanReviewState,
  repliesForTasks,
  reviewFingerprint,
  roundProgress,
  taskClusters,
  taskFingerprint,
} from "./planReview.js";

function task(partial: Partial<TaskItem> & Pick<TaskItem, "id" | "acceptance">): TaskItem {
  return {
    title: partial.id,
    description: partial.description ?? "不做檔案",
    dependsOn: [],
    ...partial,
  };
}

const ac = (ids: string[]): AcceptanceItem[] => ids.map((id) => ({ id, description: `${id} 行為` }));
const layers = { enabled: true, minTasks: 7, maxGroups: 5, tasksPerGroup: 3 };
const headings = (tasks: TaskItem[]) => ["# 計畫", "整體做法", ...tasks.flatMap((item) => [`## ${item.id} 難度`, "低"])].join("\n");
const split = (count: number, inA: number) => Array.from({ length: count }, (_, i) => task({
  id: `T-${i + 1}`, acceptance: [`AC-${i + 1}`], description: i < inA ? "改 src/a.ts" : "改 src/b.ts",
}));

describe("計畫審查分群", () => {
  it("共用路徑的任務併成一群，檔名任務只依附抽得到路徑的直接上游", () => {
    const tasks = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/a.ts 與 src/b.ts", dependsOn: ["T-1"] }),
      task({ id: "T-3", acceptance: ["AC-3"], description: "改 src/b.ts" }),
      task({ id: "T-4", acceptance: ["AC-4"], description: "沒有路徑", dependsOn: ["T-3"] }),
      task({ id: "T-5", acceptance: ["AC-5"], description: "也沒有路徑", dependsOn: ["T-4"] }),
      task({ id: "T-6", acceptance: ["AC-6"], description: "改 src/c.ts", dependsOn: ["T-1"] }),
    ];
    expect(taskClusters(tasks)).toEqual([
      { id: "G-1", taskIds: ["T-1", "T-2", "T-3", "T-4"], files: ["src/a.ts", "src/b.ts"] },
      { id: "G-2", taskIds: ["T-5"], files: [] },
      { id: "G-3", taskIds: ["T-6"], files: ["src/c.ts"] },
    ]);
  });

  it("沒依附到路徑的檔名任務全部併成同一群", () => {
    const tasks = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "沒有路徑" }),
      task({ id: "T-3", acceptance: ["AC-3"], description: "也沒有路徑" }),
      task({ id: "T-4", acceptance: ["AC-4"], description: "改 src/b.ts" }),
    ];
    expect(taskClusters(tasks).map((group) => group.taskIds)).toEqual([["T-1"], ["T-2", "T-3"], ["T-4"]]);
  });

  it("抽不到路徑的任務同時依附多個有路徑的上游時，只併入第一個目標的群，不合併那些群", () => {
    const tasks = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/b.ts" }),
      task({ id: "T-3", acceptance: ["AC-3"], description: "沒有路徑", dependsOn: ["T-1", "T-2"] }),
    ];
    expect(taskClusters(tasks)).toEqual([
      { id: "G-1", taskIds: ["T-1", "T-3"], files: ["src/a.ts"] },
      { id: "G-2", taskIds: ["T-2"], files: ["src/b.ts"] },
    ]);
  });

  it("群數同時受 maxGroups 與任務數除以 tasksPerGroup 限制，超過時合併相鄰的群", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task({
      id: `T-${i + 1}`, acceptance: [`AC-${i + 1}`], description: `改 src/f${i + 1}.ts`,
    }));
    expect(planReviewGroups(tasks, { ...layers, tasksPerGroup: 1 }).map((group) => group.taskIds)).toEqual([
      ["T-1", "T-2"], ["T-3"], ["T-4", "T-5"], ["T-6"], ["T-7"],
    ]);
    const packed = planReviewGroups(tasks, layers);
    expect(packed.map((group) => group.taskIds)).toEqual([["T-1", "T-2", "T-3", "T-4"], ["T-5", "T-6", "T-7"]]);
    expect(packed.map((group) => group.id)).toEqual(["G-1", "G-2"]);
    expect(packed[1]!.files).toEqual(["src/f5.ts", "src/f6.ts", "src/f7.ts"]);
  });

  it("略過 .flow 與沒有斜線的檔名", () => {
    expect(extractFiles("看 .flow/tasks.json 與 feature.ts 與 src/feature.ts")).toEqual(["src/feature.ts"]);
  });

  it("中文標點後面的路徑也抓得到，URL 片段不算", () => {
    expect(extractFiles("改 src/a.ts、src/b.ts，檔案：src/c.ts 與「src/d.ts」")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(extractFiles("參考 https://example.com/x/y.js")).toEqual([]);
  });

  it("相鄰任務是跨群的直接上下游，依任務順序", () => {
    const tasks = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/a.ts", dependsOn: ["T-1"] }),
      task({ id: "T-3", acceptance: ["AC-3"], description: "改 src/b.ts", dependsOn: ["T-2"] }),
      task({ id: "T-4", acceptance: ["AC-4"], description: "改 src/b.ts" }),
      task({ id: "T-5", acceptance: ["AC-5"], description: "改 src/c.ts", dependsOn: ["T-4"] }),
    ];
    expect(neighborTasks(tasks, ["T-3", "T-4"]).map((item) => item.id)).toEqual(["T-2", "T-5"]);
    expect(neighborTasks(tasks, ["T-1", "T-2", "T-3", "T-4", "T-5"])).toEqual([]);
  });

  it("含 high 任務的群由 quorum 位審查，其餘一位", () => {
    const low = task({ id: "T-1", acceptance: ["AC-1"], complexity: "low" });
    const high = task({ id: "T-2", acceptance: ["AC-2"], complexity: "high" });
    expect(groupReviewerCount([low, high], 2)).toBe(2);
    expect(groupReviewerCount([low], 2)).toBe(1);
  });

  it("索引有 id、標題、驗收 id、相依與一行描述", () => {
    const tasks = [
      task({ id: "T-1", title: "建立表單", acceptance: ["AC-1"], description: "改 src/form.ts 的欄位" }),
      task({ id: "T-2", title: "送出", acceptance: ["AC-2", "AC-3"], dependsOn: ["T-1"], description: "呼叫 API\n  失敗時顯示錯誤" }),
    ];
    expect(planReviewIndex(tasks)).toBe([
      "- T-1 建立表單 | AC-1 | depends：（無）",
      "  改 src/form.ts 的欄位",
      "- T-2 送出 | AC-2, AC-3 | depends：T-1",
      "  呼叫 API 失敗時顯示錯誤",
    ].join("\n"));
  });
});

describe("是否分層", () => {
  it("關閉或任務數未達門檻時不分層，也不給原因", () => {
    const six = split(6, 3);
    expect(layeredReview(six, headings(six), layers)).toEqual({ layered: false });
    const seven = split(7, 3);
    expect(layeredReview(seven, headings(seven), { ...layers, enabled: false })).toEqual({ layered: false });
  });

  it("只能分成一群時說明原因", () => {
    const same = split(7, 7);
    expect(layeredReview(same, headings(same), layers)).toEqual({ layered: false, reason: "任務要改的檔案互相重疊，只能分成一群" });
  });

  it("最大一群超過三分之二時說明原因，沒寫路徑的任務占多數也算", () => {
    const lopsided = split(7, 5);
    expect(layeredReview(lopsided, headings(lopsided), layers)).toEqual({ layered: false, reason: "最大的一群有 5 個任務，超過總數 7 的三分之二" });
    const loose = Array.from({ length: 8 }, (_, i) => task({
      id: `T-${i + 1}`, acceptance: [`AC-${i + 1}`], description: i === 0 ? "改 src/a.ts" : i === 1 ? "改 src/b.ts" : "沒有路徑",
    }));
    expect(layeredReview(loose, headings(loose), layers)).toEqual({ layered: false, reason: "最大的一群有 6 個任務，超過總數 8 的三分之二" });
  });

  it("群數不足時說明原因", () => {
    const seven = split(7, 3);
    expect(layeredReview(seven, headings(seven), { ...layers, tasksPerGroup: 4 })).toEqual({ layered: false, reason: "任務數 7 不足以讓每群平均至少 4 個" });
  });

  it("plan.md 缺任務標題時說明缺哪些", () => {
    const seven = split(7, 3);
    expect(layeredReview(seven, headings(seven.slice(0, 5)), layers)).toEqual({ layered: false, reason: "plan.md 缺少 T-6, T-7 的「## T-<數字>」標題" });
  });

  it("條件都符合時分層並回傳群", () => {
    const seven = split(7, 3);
    const decision = layeredReview(seven, headings(seven), layers);
    expect(decision.layered).toBe(true);
    expect(decision.layered && decision.groups.map((group) => group.taskIds)).toEqual([["T-1", "T-2", "T-3"], ["T-4", "T-5", "T-6", "T-7"]]);
  });

  it("任務標題接冒號或頓號也算數，T-10 不會被當成 T-1 的標題", () => {
    const plan = ["## T-1：標題", "## T-2、說明", "## T-10 難度"].join("\n");
    expect(missingTaskHeadings(plan, ["T-1", "T-2"])).toEqual([]);
    expect(missingTaskHeadings(plan, ["T-1"])).toEqual([]);
    expect(missingTaskHeadings("## T-10 難度", ["T-1"])).toEqual(["T-1"]);
  });
});

describe("髒任務", () => {
  const tasks = [
    task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
    task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/b.ts", dependsOn: ["T-1"] }),
  ];
  const acceptance = ac(["AC-1", "AC-2"]);
  const plan = headings(tasks);
  const approveAll = () => applyReviewVerdicts(undefined, tasks, acceptance, plan, [{ taskIds: ["T-1", "T-2"], verdict: "approve" }]);

  it("沒有前次結果時全部髒；壞掉的狀態檔讀不到", () => {
    expect(dirtyTaskIds(undefined, tasks, acceptance, plan)).toEqual(["T-1", "T-2"]);
    expect(readPlanReviewState("{")).toBeUndefined();
    expect(readPlanReviewState("null")).toBeUndefined();
    expect(readPlanReviewState(JSON.stringify({ version: 1 }))).toEqual({ version: 1 });
  });

  it("仲裁待完成紀錄壞掉或缺欄位時讀不到", () => {
    expect(readPendingArbitration("{")).toBeUndefined();
    expect(readPendingArbitration(JSON.stringify({ planReviewer: "b" }))).toBeUndefined();
    expect(readPendingArbitration(JSON.stringify({ planReviewer: "b", planKey: "k" }))).toEqual({ planReviewer: "b", planKey: "k" });
  });

  it("只改描述時不牽動相依的另一群", () => {
    const edited = [{ ...tasks[0]!, description: "改 src/a.ts 的錯誤訊息" }, tasks[1]!];
    expect(dirtyTaskIds(approveAll(), edited, acceptance, plan)).toEqual(["T-1"]);
  });

  it("只改某任務的難度證據時只有那個任務髒", () => {
    const edited = plan.replace("## T-2 難度\n低", "## T-2 難度\n中：要協調兩個模組");
    expect(dirtyTaskIds(approveAll(), tasks, acceptance, edited)).toEqual(["T-2"]);
  });

  it("整體做法變了時全部髒", () => {
    expect(dirtyTaskIds(approveAll(), tasks, acceptance, plan.replace("整體做法", "改用另一種做法"))).toEqual(["T-1", "T-2"]);
  });

  it("前次要求修改且內容沒變時，該任務仍要重審", () => {
    const prev = applyReviewVerdicts(undefined, tasks, acceptance, plan, [
      { taskIds: ["T-1"], verdict: "changes_requested" },
      { taskIds: ["T-2"], verdict: "approve" },
    ]);
    expect(dirtyTaskIds(prev, tasks, acceptance, plan)).toEqual(["T-1"]);
  });

  it("同一群有一位要求修改就記成要求修改，不論順序", () => {
    const prev = applyReviewVerdicts(undefined, tasks, acceptance, plan, [
      { taskIds: ["T-1", "T-2"], verdict: "changes_requested" },
      { taskIds: ["T-1", "T-2"], verdict: "approve" },
    ]);
    expect(prev.tasks["T-1"]?.verdict).toBe("changes_requested");
    expect(prev.tasks["T-2"]?.verdict).toBe("changes_requested");
  });

  it("改了驗收條件時只標髒自己與直接上下游", () => {
    const extra = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/b.ts", dependsOn: ["T-1"] }),
      task({ id: "T-3", acceptance: ["AC-1"], description: "改 src/c.ts" }),
    ];
    const extraPlan = headings(extra);
    const prev = applyReviewVerdicts(undefined, extra, acceptance, extraPlan, [
      { taskIds: ["T-1", "T-2", "T-3"], verdict: "approve" },
    ]);
    const edited = [{ ...extra[0]!, acceptance: ["AC-1", "AC-2"] }, extra[1]!, extra[2]!];
    expect(dirtyTaskIds(prev, edited, acceptance, extraPlan).sort()).toEqual(["T-1", "T-2"]);
  });

  it("改了相依就把直接上下游標髒", () => {
    const edited = [tasks[0]!, { ...tasks[1]!, dependsOn: [] }];
    expect(dirtyTaskIds(approveAll(), edited, acceptance, plan).sort()).toEqual(["T-1", "T-2"]);
  });

  it("意見指紋排序後串接，空意見得到空字串", () => {
    expect(reviewFingerprint(["b", "a"])).toBe("a\nb");
    expect(reviewFingerprint([])).toBe("");
  });
});

describe("摘錄與審查回應", () => {
  it("整體做法取第一個任務標題之前的內容", () => {
    expect(planOverview(["# 計畫", "整體做法", "## T-1 難度", "證據"].join("\n"))).toBe(["# 計畫", "整體做法"].join("\n"));
    expect(planOverview(["# 計畫", "沒有任務標題"].join("\n"))).toBe(["# 計畫", "沒有任務標題"].join("\n"));
  });

  it("只認任務標題切段，內文提到其他任務不切，每個任務最多 40 行", () => {
    const body = [
      "# 計畫", "整體做法",
      "## T-1 難度", "- 需要 T-2 先完成", ...Array.from({ length: 50 }, (_, i) => `行 ${i}`),
      "## T-2 難度", "只有這行",
      "## T-10 難度", "別管",
      "## 仲裁紀錄", "不屬於任務",
    ].join("\n");
    const excerpt = extractPlanEvidence(body, ["T-1"]);
    expect(excerpt.startsWith("## T-1 難度")).toBe(true);
    expect(excerpt).toContain("- 需要 T-2 先完成");
    expect(excerpt).not.toContain("## T-2");
    expect(excerpt.split("\n")).toHaveLength(40);
    expect(extractPlanEvidence(body, ["T-2"])).toBe(["## T-2 難度", "只有這行"].join("\n"));
    expect(extractPlanEvidence(body, ["T-10"])).toBe(["## T-10 難度", "別管"].join("\n"));
    expect(extractPlanEvidence(body, ["T-3"])).toBe("");
  });

  it("任務標題接冒號或頓號時也能切出證據，不會被 T-10 誤配", () => {
    const colon = ["## T-1：建立表單", "冒號標題的證據", "## T-10 難度", "別管"].join("\n");
    expect(extractPlanEvidence(colon, ["T-1"])).toBe(["## T-1：建立表單", "冒號標題的證據"].join("\n"));
    const dun = ["## T-1、說明", "頓號標題的證據", "## T-10 難度", "別管"].join("\n");
    expect(extractPlanEvidence(dun, ["T-1"])).toBe(["## T-1、說明", "頓號標題的證據"].join("\n"));
    expect(extractPlanEvidence(["## T-10 難度", "別管"].join("\n"), ["T-1"])).toBe("");
  });

  it("審查回應只比對標題上的任務 id，T-1 不帶走 T-10", () => {
    const replies = ["## T-10", "別管", "## T-1", "要留", "## 整體", "沒有任務 id"].join("\n");
    expect(repliesForTasks(replies, ["T-1"])).toBe(["## T-1", "要留"].join("\n"));
    expect(repliesForTasks(["## T-2", "拆開"].join("\n"), ["T-2"])).toBe(["## T-2", "拆開"].join("\n"));
  });

  it("審查回應標題接冒號或頓號也能對應到任務，且不會被 T-10 誤配", () => {
    expect(repliesForTasks(["## T-1：要留", "內容"].join("\n"), ["T-1"])).toBe(["## T-1：要留", "內容"].join("\n"));
    expect(repliesForTasks(["## T-1、T-2 一起回覆", "內容"].join("\n"), ["T-1"])).toBe(["## T-1、T-2 一起回覆", "內容"].join("\n"));
    expect(repliesForTasks(["## T-10：別管", "內容"].join("\n"), ["T-1"])).toBe("");
  });

  it("指紋含驗收條文與該任務的難度證據，不含其他任務", () => {
    const item = task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts", complexity: "low" });
    const plan = ["# 計畫", "## T-1 難度", "只動一個檔案", "## T-2 難度", "別的任務"].join("\n");
    const print = taskFingerprint(item, ac(["AC-1", "AC-9"]), plan);
    expect(print).toContain("AC-1 行為");
    expect(print).toContain("只動一個檔案");
    expect(print).not.toContain("AC-9");
    expect(print).not.toContain("別的任務");
  });

  it("指紋含 tdd，只改標記會讓該任務重審", () => {
    const item = task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" });
    const plan = "## T-1 難度\n低";
    const acceptance = ac(["AC-1"]);
    expect(taskFingerprint(item, acceptance, plan)).not.toBe(taskFingerprint({ ...item, tdd: false }, acceptance, plan));
  });
});

describe("審查狀態與本輪進度", () => {
  it("沒審到的任務保留前次 verdict，消失的任務不留", () => {
    const acceptance = ac(["AC-1", "AC-2"]);
    const first = [
      task({ id: "T-1", acceptance: ["AC-1"], description: "改 src/a.ts" }),
      task({ id: "T-2", acceptance: ["AC-2"], description: "改 src/b.ts" }),
    ];
    const plan = headings(first);
    const prev = applyReviewVerdicts(undefined, first, acceptance, plan, [
      { taskIds: ["T-1"], verdict: "approve" },
      { taskIds: ["T-2"], verdict: "approve" },
    ]);
    const next = applyReviewVerdicts(prev, [first[0]!], acceptance, plan, []);
    expect(next.tasks["T-1"]?.verdict).toBe("approve");
    expect(next.tasks["T-2"]).toBeUndefined();
    expect(next.overview).toBe(prev.overview);
    expect(dirtyGroups(taskClusters(first), ["T-1"]).map((group) => group.id)).toEqual(["G-1"]);
  });

  it("本輪進度只在輪次與計畫內容都相同時沿用", () => {
    const key = planContentKey(["tasks", "acceptance", "plan", ""]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(planContentKey(["tasks", "acceptance", "plan", "回應"])).not.toBe(key);
    const state = readPlanReviewState(JSON.stringify({
      version: 1,
      round: { round: 2, planKey: key, calls: [{ key: "index:b", reviewer: "b", verdict: "approve", issueLines: [] }] },
    }));
    expect(roundProgress(state, 2, key)?.calls.map((call) => call.key)).toEqual(["index:b"]);
    expect(roundProgress(state, 3, key)).toBeUndefined();
    expect(roundProgress(state, 2, "other")).toBeUndefined();
    expect(roundProgress(undefined, 2, key)).toBeUndefined();
  });
});
