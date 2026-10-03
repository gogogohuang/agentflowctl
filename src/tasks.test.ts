import { describe, expect, it } from "vitest";
import { TaskItem } from "./schemas.js";
import { confirmationChecklist, splitHumanItems, confirmationLines, confirmationTasks, describedDirs, describedPaths, orderTasks, overlappingParallelTasks, parallelOverlapMessage, outOfScopeFiles, taskAcceptance, validateTaskComplexity, validateTddFlag } from "./tasks.js";

const task = (id: string, dependsOn: string[] = [], acceptance = ["AC-1"]) =>
  TaskItem.parse({ id, title: id, description: id, dependsOn, acceptance });

describe("orderTasks", () => {
  it("依相依關係排序", () => {
    const r = orderTasks([task("T-3", ["T-2"], ["AC-3"]), task("T-1"), task("T-2", ["T-1"], ["AC-2"])], new Set(["AC-1", "AC-2", "AC-3"]));
    expect(Array.isArray(r) && r.map((t) => t.id)).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("偵測循環相依", () => {
    const r = orderTasks([task("T-1", ["T-2"]), task("T-2", ["T-1"], ["AC-2"])], new Set(["AC-1", "AC-2"]));
    expect(r).toContain("循環相依");
  });

  it("偵測不存在的相依與驗收條件", () => {
    const r = orderTasks([task("T-1", ["T-9"], ["AC-7"])], new Set(["AC-1"]));
    expect(r).toContain("T-9 不存在");
    expect(r).toContain("AC-7 不存在");
    expect(r).toContain("AC-1 沒有任何任務負責");
  });

  it("偵測重複 id", () => {
    expect(orderTasks([task("T-1"), task("T-1", [], ["AC-2"])], new Set(["AC-1", "AC-2"]))).toContain("重複");
  });

  it("一個任務最多對應四條驗收條件", () => {
    const acs = new Set(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"]);
    expect(Array.isArray(orderTasks([task("T-1", [], ["AC-1", "AC-2", "AC-3", "AC-4"]), task("T-2", [], ["AC-5"])], acs))).toBe(true);
    expect(orderTasks([task("T-1", [], ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"])], acs)).toContain("T-1 對應 5 條驗收條件");
  });

  it("同一條驗收條件只能由一個實作任務負責", () => {
    const acs = new Set(["AC-1", "AC-2"]);
    const r = orderTasks([task("T-1", [], ["AC-1"]), task("T-2", ["T-1"], ["AC-2"]), task("T-3", ["T-2"], ["AC-1"])], acs);
    expect(r).toContain("AC-1 同時由 T-1、T-3 負責");
    expect(r).not.toContain("AC-2");
  });

  it("多條驗收條件重複時一次列出", () => {
    const acs = new Set(["AC-1", "AC-2"]);
    const r = orderTasks([task("T-1", [], ["AC-1", "AC-2"]), task("T-2", ["T-1"], ["AC-1", "AC-2"])], acs);
    expect(r).toContain("AC-1 同時由 T-1、T-2 負責");
    expect(r).toContain("AC-2 同時由 T-1、T-2 負責");
  });

  it("人工確認任務與實作任務共用驗收條件不算重複", () => {
    const confirm = TaskItem.parse({ id: "T-2", title: "確認", description: "確認", dependsOn: [], acceptance: ["AC-1"], kind: "confirm" });
    expect(Array.isArray(orderTasks([task("T-1", [], ["AC-1"]), confirm], new Set(["AC-1"])))).toBe(true);
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

  it("PR 描述的核對清單：每項一個未勾選方塊，沒有項目時回空字串", () => {
    const md = confirmationChecklist([confirm]);
    expect(md).toContain("## 需要人工確認");
    expect(md).toContain("- [ ] **T-18 核對畫面**");
    expect(md).toContain("人眼看過首頁");
    expect(md).toContain("AC-32");
    expect(confirmationChecklist([])).toBe("");
  });

  it("splitHumanItems 把人工確認的任務、只屬於它的 AC 與計畫段落分出去", () => {
    const ac = [{ id: "AC-1" }, { id: "AC-32" }, { id: "AC-5" }, { id: "AC-9" }];
    const tasks = [
      task("T-1"),
      confirm,
      TaskItem.parse({ ...confirm, id: "T-19", acceptance: ["AC-5", "AC-1"] }),
      task("T-2", ["T-18"], ["AC-5"]),
    ];
    const plan = "整體\n\n## T-1\n實作\n\n## T-18 核對\n看首頁\n### 細節\n更多\n\n## T-2\n做事\n";
    const r = splitHumanItems(tasks, ac, plan);
    expect(r.tasks.map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(r.tasks[1]!.dependsOn).toEqual([]);
    expect(r.confirm.map((t) => t.id)).toEqual(["T-18", "T-19"]);
    // AC-32 只有 confirm 認領 → 分出；AC-5 另有 implement 任務、AC-1 有 T-1 認領 → 保留；AC-9 無人認領 → 保留
    expect(r.humanAcceptance.map((a) => a.id)).toEqual(["AC-32"]);
    expect(r.acceptance.map((a) => a.id)).toEqual(["AC-1", "AC-5", "AC-9"]);
    expect(r.planMd).not.toContain("看首頁");
    expect(r.planMd).toContain("## T-1");
    expect(r.planMd).toContain("## T-2");
    expect(r.humanPlan["T-18"]).toContain("更多");
  });

  it("draft 為 true 時標示計畫尚未定案", () => {
    const lines = confirmationLines([confirm], true).join("\n");
    expect(lines).toContain("待你確認（不進實作）");
    expect(lines).toContain("計畫尚未定案");
    expect(confirmationLines([confirm], false).join("\n")).not.toContain("計畫尚未定案");
  });
});

describe("任務範圍", () => {
  const withDescription = (id: string, description: string) => TaskItem.parse({ id, title: id, description, dependsOn: [], acceptance: ["AC-1"] });
  const tasks = [
    withDescription("T-1", "新增 src/utils/getPageContainer.ts 並沿用 src/utils/old.test.ts 的寫法。不做：改元件"),
    withDescription("T-2", "修改 src/components/CreateRewardForm.tsx，新增 src/components/CreateRewardForm.test.tsx"),
    withDescription("T-3", "刪除 ./src/utils/old.ts"),
  ];

  it("從描述抓出含目錄與副檔名的路徑", () => {
    expect([...describedPaths(tasks[1].description)]).toEqual(["src/components/CreateRewardForm.tsx", "src/components/CreateRewardForm.test.tsx"]);
    expect(describedPaths("沿用 vitest 設定，改成 1.5 倍")).toEqual(new Set());
    expect(describedPaths(tasks[2].description)).toEqual(new Set(["src/utils/old.ts"]));
  });

  it("只擋住只有後面任務提到的檔案，自己提到或沒人提到的都放行", () => {
    const found = outOfScopeFiles(tasks, 0, [
      "src/utils/getPageContainer.ts", "src/components/CreateRewardForm.tsx", "src/utils/old.ts", "package.json",
    ]);
    expect(found).toEqual([
      { file: "src/components/CreateRewardForm.tsx", owner: "T-2" },
      { file: "src/utils/old.ts", owner: "T-3" },
    ]);
  });

  it("前面任務的檔案、最後一個任務都不受限", () => {
    expect(outOfScopeFiles(tasks, 1, ["src/utils/getPageContainer.ts"])).toEqual([]);
    expect(outOfScopeFiles(tasks, 2, ["src/components/CreateRewardForm.tsx"])).toEqual([]);
  });
});

describe("範圍守衛認得目錄與根目錄檔案", () => {
  const mk = (id: string, description: string) => ({ id, title: id, description, dependsOn: [], acceptance: ["AC-1"] });

  it("描述裡的目錄與根目錄檔案也當成該任務負責的範圍", () => {
    expect(describedDirs("整理 src/auth/ 底下的檔案，並更新 ./docs/api/")).toEqual(["src/auth/", "docs/api/"]);
    expect(describedDirs("改 src/auth/login.ts，網址是 https://example.com/x/")).toEqual([]);
    expect(describedDirs("改 src/ 底下")).toEqual([]);
    expect([...describedPaths("調整 package.json 與 tsconfig.json，改成 Next.js 的寫法")]).toEqual(["package.json", "tsconfig.json", "Next.js"]);
  });

  it("目前任務動到後面任務描述的目錄底下的檔案，算越界；自己描述了同一個目錄就不算", () => {
    const tasks = [mk("T-1", "新增 src/a.ts"), mk("T-2", "整理 src/auth/ 底下的檔案")];
    expect(outOfScopeFiles(tasks, 0, ["src/a.ts", "src/auth/login.ts"])).toEqual([{ file: "src/auth/login.ts", owner: "T-2" }]);
    expect(outOfScopeFiles([mk("T-1", "整理 src/auth/"), mk("T-2", "整理 src/auth/")], 0, ["src/auth/login.ts"])).toEqual([]);
  });

  it("後面任務描述的根目錄檔案也受保護；沒有任何任務提到的檔案放行", () => {
    const tasks = [mk("T-1", "新增 src/a.ts"), mk("T-2", "更新 package.json")];
    expect(outOfScopeFiles(tasks, 0, ["package.json", "src/helper.ts"])).toEqual([{ file: "package.json", owner: "T-2" }]);
  });
});

describe("overlappingParallelTasks", () => {
  const mk = (id: string, description: string, dependsOn: string[] = [], kind?: "confirm") => ({ id, title: id, description, dependsOn, acceptance: ["AC-1"], kind });

  it("沒有相依關係卻描述同一個檔案的任務會被挑出來", () => {
    const found = overlappingParallelTasks([mk("T-1", "改 src/index.ts 與 src/a.ts"), mk("T-2", "改 src/index.ts 與 src/b.ts")]);
    expect(found).toEqual([{ a: "T-1", b: "T-2", paths: ["src/index.ts"] }]);
    expect(parallelOverlapMessage(found)).toContain("T-1 與 T-2 沒有相依關係，但都描述了 src/index.ts");
  });

  it("直接或間接相依的任務會依序執行，不算", () => {
    const tasks = [mk("T-1", "改 src/index.ts"), mk("T-2", "新增 src/b.ts", ["T-1"]), mk("T-3", "改 src/index.ts", ["T-2"])];
    expect(overlappingParallelTasks(tasks)).toEqual([]);
  });

  it("目錄與其底下的檔案、兩個重疊的目錄也算重疊", () => {
    expect(overlappingParallelTasks([mk("T-1", "整理 src/auth/"), mk("T-2", "改 src/auth/login.ts")]).map((f) => f.paths)).toEqual([["src/auth/login.ts"]]);
    expect(overlappingParallelTasks([mk("T-1", "整理 src/auth/"), mk("T-2", "整理 src/auth/oauth/")]).map((f) => f.paths)).toEqual([["src/auth/"]]);
  });

  it("沒有重疊、或其中一個是人工確認的任務，都不算", () => {
    expect(overlappingParallelTasks([mk("T-1", "改 src/a.ts"), mk("T-2", "改 src/b.ts")])).toEqual([]);
    expect(overlappingParallelTasks([mk("T-1", "改 src/a.ts"), mk("T-2", "改 src/a.ts", [], "confirm")])).toEqual([]);
  });
});
