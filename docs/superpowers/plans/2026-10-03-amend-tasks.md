# 修補任務（amend）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 後面的任務發現必須改變已合併任務的行為時，agent 寫 `.flow/amend-request.json`，引擎驗證後插入一個依賴該任務的修補任務，請求者在修補合併後從最新分支重做。

**Architecture:** 純函式模組 `src/amend.ts` 負責所有判斷（驗證請求、次數上限、冪等、組出新任務與新驗收條件）；`engine.ts` 只做檔案寫入與請求者重置。順序模式在 `implementStage` 開頭處理；平行模式由 `driveLane` 偵測車道裡的請求、回報 `amend` 結果，`scheduleLanes` 讓已在跑的車道收尾後停止，`implementLanes` 套用修補再讓 `advance()` 重新進入。

**Tech Stack:** TypeScript（Node >= 22）、zod、vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-03-amend-tasks-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。
- 新增 `FlowRun` 欄位必須是 optional，舊的 `state.json` 才讀得進來。
- 關卡判斷以程式能檢查的事實為準（檔案、zod 驗證、計數），不依賴 agent 回覆內容。
- 使用者看得到的行為變更要在同一個 commit 更新 `README.md`（本計畫集中在 Task 5，最後一個 commit 前必須完成）。
- 每個 commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- 驗證指令：`pnpm run typecheck`、`npx vitest run <檔案>`、`pnpm test`、`pnpm run build`。

## 與 spec 的差異（Task 1 一併修正 spec）

讀過程式碼後確認三處 spec 要修正：

1. 修補任務的 id 不用 `T-1-A1`：`TaskItem.id` 的 regex 是 `^T-\d+$`，而且步驟名稱以 `^T-\d+-` 判斷、審查檔以 `review-T-\d+-.+\.json` 比對。改用下一個編號 `T-<max+1>`，用新欄位 `amendOf` 記錄來源。
2. 任務的 `acceptance` 是 `acceptance.json` 的 AC id（`taskAcceptance` 找不到會丟錯）。請求裡的 `acceptance` 是文字，引擎在套用時把它們追加成新的 AC 項目（相同描述就重用既有 id）。
3. 不新增 `amendments.json` 與 `AmendLimitPause`：次數記在 `FlowRun.amendments`，達上限用既有的 `QuotaPause` 暫停。預算規則改為：套用修補時，若 `maxAgentRunsExplicit` 不為真，`maxAgentRuns` 加上 `agentRunsPerTask`。

## File Structure

- Create `src/amend.ts`：`decideAmend`、`nextId`。純函式，不碰檔案與 git。
- Create `src/amend.test.ts`：`decideAmend` 單元測試。
- Create `src/amendEngine.test.ts`：順序模式的引擎整合測試。
- Modify `src/schemas.ts`：`AmendRequest`、`TaskItem.kind` 加 `amend`、`TaskItem.amendOf`、`RepoConfig.maxAmendments`、`FlowRun.amendments`。
- Modify `src/store.ts`、`src/insights.ts`：新增重試分類 `amend_invalid`。
- Modify `src/lanes.ts`、`src/lanes.test.ts`：`amend` 車道結果與排程。
- Modify `src/engine.ts`：`applyAmendRequest`、`amendIfRequested`（順序）、`amendFromLane`（平行）、`driveLane`／`implementLanes` 接線。
- Modify `prompts/implement-tests.md`、`prompts/implement-code.md`、`prompts/implement-direct.md`：加 `<amend>` 說明。
- Modify `README.md`：`maxAmendments`、修補任務行為。

---

### Task 1: Schema、設定與分類

**Files:**
- Modify: `src/schemas.ts`（`TaskItem` 約 90–102 行、`RepoConfig` 約 261 行附近、`FlowRun` 約 329 行附近）
- Modify: `src/store.ts:164-169`（`RetryCategories`）
- Modify: `src/insights.ts:4-22`（`RETRY_LABEL`）
- Modify: `docs/superpowers/specs/2026-10-03-amend-tasks-design.md`
- Test: `src/schemas.test.ts`

**Interfaces:**
- Produces: `AmendRequest`（zod）與其型別 `{ target: string; reason: string; files: string[]; acceptance: string[] }`；`TaskItem.kind` 可為 `"amend"`；`TaskItem.amendOf?: string`；`RepoConfig.maxAmendments: number`（預設 2）；`FlowRun.amendments?: Record<string, number>`；`RetryCategory` 含 `"amend_invalid"`。

- [ ] **Step 1: 寫失敗的測試**

在 `src/schemas.test.ts` 結尾加（檔案已有 `describe`／`it`／`expect` 的匯入；若沒有 `AmendRequest` 與 `TaskItem` 匯入就補在既有的 `./schemas.js` 匯入裡）：

```ts
describe("修補請求", () => {
  it("AmendRequest 補上 files 預設值，並要求至少一條驗收條件", () => {
    const ok = AmendRequest.safeParse({ target: "T-1", reason: "回傳值要改成物件", acceptance: ["answer 為物件"] });
    expect(ok.success && ok.data.files).toEqual([]);
    expect(AmendRequest.safeParse({ target: "T-1", reason: "x", acceptance: [] }).success).toBe(false);
    expect(AmendRequest.safeParse({ target: "task1", reason: "x", acceptance: ["a"] }).success).toBe(false);
    expect(AmendRequest.safeParse({ target: "T-1", reason: "  ", acceptance: ["a"] }).success).toBe(false);
  });

  it("TaskItem 接受 amend 種類與 amendOf", () => {
    const task = TaskItem.parse({ id: "T-4", title: "修補", description: "d", acceptance: ["AC-3"], kind: "amend", amendOf: "T-1" });
    expect(task.kind).toBe("amend");
    expect(task.amendOf).toBe("T-1");
  });

  it("RepoConfig 的 maxAmendments 預設 2", () => {
    expect(RepoConfig.parse({}).maxAmendments).toBe(2);
    expect(RepoConfig.safeParse({ maxAmendments: 0 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run src/schemas.test.ts -t "修補請求"`
Expected: FAIL（`AmendRequest` 未匯出／未定義）

- [ ] **Step 3: 實作 schema**

`src/schemas.ts`：

1. `TaskItem` 的 `kind` 改成並新增 `amendOf`：

```ts
  /** confirm＝不進入實作佇列，另存給使用者確認；amend＝後面任務提出修正請求後由引擎插入的修補任務；沒寫視為要實作。舊 tasks.json 沒有此欄位 */
  kind: z.enum(["implement", "confirm", "amend"]).optional(),
  /** amend 任務修補的是哪個已合併的任務 */
  amendOf: z.string().optional(),
```

2. 在 `OrderedTaskList` 定義之前（`TaskItem` 型別宣告之後）加：

```ts
/** agent 發現必須改變已合併任務的行為時寫的 .flow/amend-request.json */
export const AmendRequest = z.object({
  target: z.string().regex(/^T-\d+$/, "target 格式必須是 T-<數字>"),
  reason: z.string().trim().min(1, "reason 不可為空"),
  files: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().trim().min(1)).min(1, "至少要寫一條修補後可驗證的條件"),
});
export type AmendRequest = z.infer<typeof AmendRequest>;
```

3. `RepoConfig` 在 `agentRunsPerTask` 之後加：

```ts
  /** 同一個已合併任務最多被後面的任務要求修補幾次；超過就暫停等人處理 */
  maxAmendments: z.number().int().min(1).default(2),
```

4. `FlowRun` 在 `doneTasks` 之後加：

```ts
  /** 各已合併任務被修補過幾次（舊 state.json 沒有此欄位） */
  amendments: z.record(z.string(), z.number().int().nonnegative()).optional(),
```

5. `src/store.ts` 的 `RetryCategories` 陣列最後加 `"amend_invalid"`：

```ts
  "tests_not_green", "tests_invalid", "tests_deleted", "out_of_scope", "checks_failed", "merge_conflict", "merge_tests_failed", "amend_invalid",
```

6. `src/insights.ts` 的 `RETRY_LABEL` 加：

```ts
  amend_invalid: "修補請求不合格",
```

- [ ] **Step 4: 修正 spec**

在 `docs/superpowers/specs/2026-10-03-amend-tasks-design.md` 做這些修改：
- 「### 2. 程式檢查」的第四項（預算足夠）改為：`套用時預算加碼：maxAgentRuns 加上 agentRunsPerTask（run／resume 明確指定過上限、即 maxAgentRunsExplicit 為真時不加）。`；「達修補上限則丟新的 `AmendLimitPause`」改為「達修補上限則丟既有的 `QuotaPause`，訊息說明被修補的任務與下一步」。
- 「### 3. 插入修補任務」：`id` 改為「下一個編號 `T-<最大編號+1>`（`TaskItem.id` 規則為 `^T-\d+$`）」；新增 `amendOf` 欄位；驗收條件改為「請求的 `acceptance` 文字由引擎追加到 `acceptance.json` 成為新的 AC 項目（相同描述重用既有 id），任務的 `acceptance` 寫這些 AC id」；刪除 `amendments.json` 與 `RUN_ENTRIES` 的敘述，次數改記 `FlowRun.amendments`。
- 「## 錯誤與邊界」冪等一項改為：`以「kind 為 amend、amendOf 與 description 都相同的任務是否已存在」判斷是否已套用`。
- 「## 測試」的 `lanes.test.ts` 之外補一行 `amend.test.ts：decideAmend 的各種判斷`。

- [ ] **Step 5: 執行測試與型別檢查**

Run: `npx vitest run src/schemas.test.ts && pnpm run typecheck`
Expected: PASS。若 typecheck 報某處對 `TaskItem.kind` 或 `Record<RetryCategory, …>` 的窮舉不完整，補上對應處理（`amend` 與 `implement` 同樣視為要實作）。

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/store.ts src/insights.ts src/schemas.test.ts docs/superpowers/specs/2026-10-03-amend-tasks-design.md
git commit -m "修補任務：新增請求 schema、maxAmendments 設定與重試分類

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `decideAmend` 純函式

**Files:**
- Create: `src/amend.ts`
- Test: `src/amend.test.ts`

**Interfaces:**
- Consumes: `AmendRequest`、`TaskItem`、`AcceptanceItem`（Task 1 與既有 `schemas.ts`）。
- Produces:

```ts
export type AmendDecision =
  | { kind: "invalid"; reason: string }
  | { kind: "limit"; reason: string }
  | { kind: "applied" }
  | { kind: "apply"; target: string; task: TaskItem; tasks: TaskItem[]; acceptance: AcceptanceItem[] };
export interface AmendInput {
  raw: string;                                   // .flow/amend-request.json 的原文
  requesterId: string;                           // 提出請求的任務 id
  tasks: readonly TaskItem[];                    // 目前的 tasks.ordered.json
  done: ReadonlySet<string>;                     // 已合併的任務 id
  acceptance: readonly AcceptanceItem[];         // 目前的 acceptance.json
  counts: Readonly<Record<string, number>>;      // FlowRun.amendments
  max: number;                                   // maxAmendments
  usedIds: readonly string[];                    // 已用過的任務 id（含另存的確認任務）
}
export function decideAmend(input: AmendInput): AmendDecision;
export function nextId(prefix: "T" | "AC", ids: readonly string[]): string;
```

- [ ] **Step 1: 寫失敗的測試**

建立 `src/amend.test.ts`：

```ts
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
});

describe("nextId", () => {
  it("取最大編號加一，沒有時從 1 開始", () => {
    expect(nextId("T", ["T-1", "T-10", "T-3"])).toBe("T-11");
    expect(nextId("AC", [])).toBe("AC-1");
    expect(nextId("AC", ["T-5", "AC-2"])).toBe("AC-3");
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run src/amend.test.ts`
Expected: FAIL（找不到 `./amend.js`）

- [ ] **Step 3: 實作**

建立 `src/amend.ts`：

```ts
import { AmendRequest, type AcceptanceItem, type TaskItem } from "./schemas.js";

/**
 * 修補請求的判斷：只看程式能驗證的事實（格式、目標是否已合併、次數、是否已套用），
 * 不碰檔案與 git。請求合不合理由修補任務之後的任務審查把關。
 */

export type AmendDecision =
  | { kind: "invalid"; reason: string }
  | { kind: "limit"; reason: string }
  | { kind: "applied" }
  | { kind: "apply"; target: string; task: TaskItem; tasks: TaskItem[]; acceptance: AcceptanceItem[] };

export interface AmendInput {
  /** .flow/amend-request.json 的原文 */
  raw: string;
  /** 提出請求的任務 id */
  requesterId: string;
  tasks: readonly TaskItem[];
  /** 已合併的任務 id */
  done: ReadonlySet<string>;
  acceptance: readonly AcceptanceItem[];
  /** FlowRun.amendments：各已合併任務被修補過幾次 */
  counts: Readonly<Record<string, number>>;
  max: number;
  /** 已用過的任務 id（含另存給人確認的任務） */
  usedIds: readonly string[];
}

const numberOf = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));

/** 下一個編號：同前綴的最大編號加一，沒有就從 1 開始 */
export function nextId(prefix: "T" | "AC", ids: readonly string[]): string {
  const max = ids.filter((id) => id.startsWith(`${prefix}-`)).reduce((m, id) => Math.max(m, numberOf(id)), 0);
  return `${prefix}-${max + 1}`;
}

const describeAmend = (req: AmendRequest) =>
  req.files.length ? `${req.reason}\n\n預計修改：${req.files.join("、")}` : req.reason;

export function decideAmend(input: AmendInput): AmendDecision {
  const invalid = (reason: string): AmendDecision => ({ kind: "invalid", reason });
  let json: unknown;
  try {
    json = JSON.parse(input.raw);
  } catch {
    return invalid("amend-request.json 不是合法的 JSON");
  }
  const parsed = AmendRequest.safeParse(json);
  if (!parsed.success) {
    return invalid(`amend-request.json 格式不正確：${parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join("；")}`);
  }
  const req = parsed.data;
  const requester = input.tasks.find((t) => t.id === input.requesterId);
  if (!requester) return invalid(`找不到提出請求的任務 ${input.requesterId}`);
  if (req.target === input.requesterId) return invalid("不能修補自己；請在這個任務內完成");
  if (!input.tasks.some((t) => t.id === req.target)) return invalid(`找不到任務 ${req.target}`);
  if (!input.done.has(req.target)) {
    return invalid(`${req.target} 還沒合併；尚未完成的任務請在它自己的任務內處理，或寫進 .flow/handoff-response.json 的 newIssues`);
  }
  const description = describeAmend(req);
  if (input.tasks.some((t) => t.kind === "amend" && t.amendOf === req.target && t.description === description)) {
    return { kind: "applied" };
  }
  const used = input.counts[req.target] ?? 0;
  if (used >= input.max) return { kind: "limit", reason: `${req.target} 已被修補 ${used} 次，達到上限 ${input.max}` };

  const acceptance = [...input.acceptance];
  const acIds = req.acceptance.map((text) => {
    const existing = acceptance.find((a) => a.description === text);
    if (existing) return existing.id;
    const id = nextId("AC", acceptance.map((a) => a.id));
    acceptance.push({ id, description: text });
    return id;
  });
  const id = nextId("T", [...input.usedIds, ...input.tasks.map((t) => t.id)]);
  const task: TaskItem = {
    id,
    title: `修補 ${req.target}：${req.reason.split("\n")[0].slice(0, 40)}`,
    description,
    dependsOn: [req.target],
    acceptance: acIds,
    kind: "amend",
    amendOf: req.target,
  };
  const tasks = input.tasks.flatMap((t) =>
    t.id === input.requesterId ? [task, { ...t, dependsOn: [...new Set([...t.dependsOn, id])] }] : [t]);
  return { kind: "apply", target: req.target, task, tasks, acceptance };
}
```

- [ ] **Step 4: 確認通過**

Run: `npx vitest run src/amend.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/amend.ts src/amend.test.ts
git commit -m "修補任務：新增 decideAmend 判斷請求並組出修補任務

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 順序模式的引擎接線

**Files:**
- Modify: `src/engine.ts`（匯入區約 8–61 行；新函式放在 `implementStage` 之前；`implementStage` 開頭約 1257–1265 行）
- Test: `src/amendEngine.test.ts`

**Interfaces:**
- Consumes: `decideAmend`、`AmendDecision`（Task 2）；engine 內既有的 `loadOrderedTasks`、`loadConfirmations`、`flowFile`、`readJsonFile`、`saveRun`、`retry`、`info`、`doneSet`、`resetTo`、`discardChanges`、`loadRepoConfig`、`AcceptanceList`、`QuotaPause`。
- Produces（供 Task 4 使用）：

```ts
type AmendApplied = { kind: "invalid" | "limit"; reason: string } | { kind: "applied"; run: FlowRun };
function applyAmendRequest(run: FlowRun, raw: string, requesterId: string, tasks: TaskItem[], done: ReadonlySet<string>): AmendApplied;
```

- [ ] **Step 1: 寫失敗的測試**

建立 `src/amendEngine.test.ts`（結構仿 `src/engine.test.ts` 的 `implementRun`）：

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-amend-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "base.txt"), "base\n");
execFileSync("git", ["-C", root, "add", "base.txt"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const { addWorktree } = await import("./git.js");
const { advance, resetQuotaState } = await import("./engine.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { listRetries } = await import("./store.js");

beforeEach(() => resetQuotaState());

// 紅燈階段：若 .flow/amend-request.txt 存在就把它當成請求寫出（只寫一次），其餘照常寫測試與實作
const script = join(root, "implementer.mjs");
writeFileSync(script, `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const phase = prompt.includes("<red_output>") ? "code" : prompt.includes("<no_tdd>") ? "direct" : "tests";
writeFileSync(\`.flow/prompt-\${phase}.txt\`, prompt);
if (phase === "tests" && existsSync(".flow/amend-request.txt")) renameSync(".flow/amend-request.txt", ".flow/amend-request.json");
if (phase === "tests") writeFileSync("feature.test.mjs", 'import { answer } from "./feature.mjs";\\nif (answer !== 42) process.exit(1);\\n');
else writeFileSync("feature.mjs", "export const answer = 42;\\n");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
`);

async function amendRun(id: string, request: unknown, { amendments, maxAgentRuns = 2 }: { amendments?: Record<string, number>; maxAgentRuns?: number } = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({ diverge: { enabled: false },
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", script] }])),
    cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
  }));
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([
    { id: "AC-1", description: "T-1 的條件" }, { id: "AC-2", description: "T-2 的條件" },
  ]));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
    { id: "T-1", title: "第一個", description: "已完成", dependsOn: [], acceptance: ["AC-1"] },
    { id: "T-2", title: "第二個", description: "匯出 answer", dependsOn: ["T-1"], acceptance: ["AC-2"] },
  ]));
  writeFileSync(join(flowDir(id), "amend-request.txt"), JSON.stringify(request));
  const now = new Date().toISOString();
  // T-1 在 taskIndex 之前，視為已完成；T-2 從紅燈開始，maxAgentRuns 讓第二次 agent 執行後就停下
  return advance({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage: "implement",
    autopilot: true, maxAgentRuns, maxAgentRunsExplicit: true, cycle: ["a", "b"], attempts: {},
    taskIndex: 1, taskPhase: "tests", ...(amendments ? { amendments } : {}), createdAt: now, updatedAt: now,
  });
}

const goodRequest = { target: "T-1", reason: "T-1 的回傳值要改成物件", files: ["feature.mjs"], acceptance: ["answer 為物件"] };
const tasksOf = (id: string) => JSON.parse(readFileSync(join(flowDir(id), "tasks.ordered.json"), "utf8")) as { id: string; kind?: string; dependsOn: string[]; acceptance: string[] }[];

describe("順序模式的修補請求", () => {
  it("合格的請求插入修補任務、重置請求者，下一個執行的是修補任務", async () => {
    const run = await amendRun("amend-ok", goodRequest);
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-3", "T-2"]);
    expect(tasksOf(run.id)[1]).toMatchObject({ kind: "amend", dependsOn: ["T-1"], acceptance: ["AC-3"] });
    expect(tasksOf(run.id)[2].dependsOn).toEqual(["T-1", "T-3"]);
    expect(JSON.parse(readFileSync(join(flowDir(run.id), "acceptance.json"), "utf8"))).toContainEqual({ id: "AC-3", description: "answer 為物件" });
    expect(run.amendments).toEqual({ "T-1": 1 });
    expect(run.taskIndex).toBe(1);
    // 第二次 agent 執行寫的是修補任務的紅燈
    expect(readFileSync(join(flowDir(run.id), "prompt-tests.txt"), "utf8")).toContain("T-3");
    expect(existsSync(join(flowDir(run.id), "amend-request.json"))).toBe(false);
    expect(run.taskPhase).toBe("code");
  }, 30_000);

  it("無效的請求用 retry 把原因寫給請求者，不改任務清單", async () => {
    const run = await amendRun("amend-invalid", { ...goodRequest, target: "T-9" });
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(listRetries(run.id).some((r) => r.category === "amend_invalid")).toBe(true);
    expect(run.amendments).toBeUndefined();
  }, 30_000);

  it("達到修補上限時暫停，並要求請求者在自己的任務內完成", async () => {
    const run = await amendRun("amend-limit", goodRequest, { amendments: { "T-1": 2 }, maxAgentRuns: 5 });
    expect(run.stage).toBe("paused");
    expect(run.pauseReason).toMatch(/T-1.*上限/);
    expect(tasksOf(run.id).map((t) => t.id)).toEqual(["T-1", "T-2"]);
    expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toContain("修補");
  }, 30_000);
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run src/amendEngine.test.ts`
Expected: FAIL（任務清單沒有被改動；`amend-ok` 第一個斷言失敗）

- [ ] **Step 3: 實作**

`src/engine.ts`：

1. 匯入：加 `import { decideAmend } from "./amend.js";`（與其他本地匯入放一起）。確認 `AcceptanceList`、`readJsonFile` 已匯入（`implementStage` 內已使用），`rmSync`、`readFileSync`、`writeFileSync`、`existsSync` 已從 `node:fs` 匯入。

2. 在 `implementStage` 定義之前加：

```ts
// ── 修補請求：後面的任務發現必須改變已合併任務的行為 ──

type AmendApplied = { kind: "invalid" | "limit"; reason: string } | { kind: "applied"; run: FlowRun };

/**
 * 判斷請求並套用：追加驗收條件、插入修補任務、記次數並加碼預算。
 * 只動 run 層級的檔案與狀態，請求者的重置由呼叫端負責（順序與車道的做法不同）。
 * 寫檔順序固定為 acceptance → tasks → run 狀態，decideAmend 以任務是否已存在判斷冪等，所以中途中斷後重做不會重複插入。
 */
function applyAmendRequest(run: FlowRun, raw: string, requesterId: string, tasks: TaskItem[], done: ReadonlySet<string>): AmendApplied {
  const acceptance = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  if (!acceptance.ok) throw new Error(acceptance.error);
  const cfg = loadRepoConfig();
  const decision = decideAmend({
    raw, requesterId, tasks, done, acceptance: acceptance.data, counts: run.amendments ?? {}, max: cfg.maxAmendments,
    usedIds: loadConfirmations(run).map((t) => t.id),
  });
  if (decision.kind === "invalid" || decision.kind === "limit") return decision;
  if (decision.kind === "applied") return { kind: "applied", run };
  writeFileSync(flowFile(run, "acceptance.json"), JSON.stringify(decision.acceptance, null, 2));
  writeFileSync(flowFile(run, "tasks.ordered.json"), JSON.stringify(decision.tasks, null, 2));
  const budget = run.maxAgentRunsExplicit ? run.maxAgentRuns : run.maxAgentRuns + cfg.agentRunsPerTask;
  const next = saveRun({
    ...run,
    amendments: { ...run.amendments, [decision.target]: (run.amendments?.[decision.target] ?? 0) + 1 },
    maxAgentRuns: budget,
  });
  info(next, `🩹 ${requesterId} 要求修補 ${decision.target}，已插入 ${decision.task.id}（${decision.task.title}）`);
  return { kind: "applied", run: next };
}

/** 修補達上限時給請求者的指示：停止要求修補，改在自己的任務內完成 */
const amendLimitFeedback = (reason: string) =>
  `${reason}。不要再提出修補請求：請在自己的任務內完成，或把問題寫進 .flow/handoff-response.json 的 newIssues 交給人決定。`;

/**
 * 順序模式：請求者是目前的任務。有 .flow/amend-request.json 就處理，回傳新的 run；沒有請求回傳 undefined。
 * 套用後請求者回到紅燈（半成品丟棄），修補任務排在它的位置，所以 taskIndex 不變就會先做修補任務。
 */
async function amendIfRequested(run: FlowRun, tasks: TaskItem[], task: TaskItem): Promise<FlowRun | undefined> {
  const file = flowFile(run, "amend-request.json");
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8");
  const result = applyAmendRequest(run, raw, task.id, tasks, doneSet(tasks, run.taskIndex, run.doneTasks));
  rmSync(file, { force: true });
  if (result.kind === "invalid") return retry(run, `${task.id}:amend`, result.reason, "implement", "amend_invalid");
  if (result.kind === "limit") {
    const reason = amendLimitFeedback(result.reason);
    mkdirSync(flowDir(run.id), { recursive: true });
    writeFileSync(flowFile(run, "feedback.md"), `# 修補請求未被接受\n\n${reason}\n`);
    throw new QuotaPause(`${task.id} 的修補請求被拒絕：${result.reason}；請檢查 .flow/feedback.md 後 resume，或用 replan 調整計畫`);
  }
  const repo = worktreeDir(run.id);
  if (run.taskPhase === "tests" || !run.taskBase) await discardChanges(repo);
  else await resetTo(repo, run.taskBase);
  const attempts = Object.fromEntries(Object.entries(result.run.attempts).filter(([key]) => !key.startsWith(`${task.id}:`)));
  return {
    ...result.run, attempts, taskPhase: "tests", taskBase: undefined, testsCommit: undefined, lastTestsAuthor: undefined,
    testsRedos: undefined, lastWriter: undefined, lastReviewer: undefined, fixSource: undefined,
  };
}
```

3. `implementStage` 開頭，在 `if (!task) { ... }` 區塊之後、`const cfg = loadRepoConfig();` 之前加：

```ts
  if (!inLane(run)) {
    const amended = await amendIfRequested(run, tasks, task);
    if (amended) return amended;
  }
```

- [ ] **Step 4: 確認通過**

Run: `npx vitest run src/amendEngine.test.ts && pnpm run typecheck`
Expected: PASS。若 `amend-ok` 的 `taskPhase` 斷言不是 `"code"`，印出 `run.stage`／`run.failureReason` 判斷是預算停在哪一步，調整 `maxAgentRuns`（讓修補任務的紅燈剛好跑完）而不是放寬斷言。

- [ ] **Step 5: 全部測試**

Run: `pnpm test`
Expected: PASS（既有測試不應受影響；若 `schemas.test.ts` 有 config 預設值的整份比對，補上 `maxAmendments: 2`）。

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/amendEngine.test.ts
git commit -m "修補任務：順序模式處理 amend-request.json

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 平行模式（車道）

**Files:**
- Modify: `src/lanes.ts`、`src/lanes.test.ts`
- Modify: `src/engine.ts`（`driveLane` 約 1507 行、`implementLanes` 約 1580 行；匯入的 `LaneOutcome`）

**Interfaces:**
- Consumes: `applyAmendRequest`、`amendLimitFeedback`（Task 3）。
- Produces:

```ts
// lanes.ts
export type LaneOutcome =
  | { kind: "done" }
  | { kind: "failed"; reason: string; category?: string }
  | { kind: "paused"; reason: string }
  | { kind: "amend"; request: string };
export type AmendResolution = "retry" | "restart" | { kind: "failed"; reason: string; category?: string } | { kind: "paused"; reason: string };
// LaneHooks 新增（optional，沒提供視為失敗）：
//   amend?(task: TaskItem, request: string): Promise<AmendResolution>;
// LaneResult 新增：restart?: boolean
```

- [ ] **Step 1: 寫失敗的排程測試**

先讀 `src/lanes.test.ts` 開頭確認 `task()` 輔助函式的簽名（`task(id, dependsOn?)`），然後在檔案結尾（最後一個 `describe` 之後）加：

```ts
describe("scheduleLanes：修補請求", () => {
  it("amend 結果交給 hooks.amend；回 restart 後不再開新車道，已在跑的車道收尾合併，結果標記 restart", async () => {
    const started: string[] = [];
    const merged: string[] = [];
    const result = await scheduleLanes([task("T-1"), task("T-2"), task("T-3", ["T-1"])], new Set(), 2, {
      async start(t): Promise<LaneOutcome> {
        started.push(t.id);
        return t.id === "T-1" ? { kind: "amend", request: "{}" } : { kind: "done" };
      },
      async merge(t) { merged.push(t.id); return "merged" as const; },
      async amend() { return "restart" as const; },
    });
    expect(result.restart).toBe(true);
    expect(started).toEqual(["T-1", "T-2"]);
    expect(merged).toEqual(["T-2"]);
    expect(result.done.has("T-1")).toBe(false);
  });

  it("amend 回 retry 時讓同一個任務重跑", async () => {
    let calls = 0;
    const result = await scheduleLanes([task("T-1")], new Set(), Infinity, {
      async start(): Promise<LaneOutcome> { calls += 1; return calls === 1 ? { kind: "amend", request: "{}" } : { kind: "done" }; },
      async merge() { return "merged" as const; },
      async amend() { return "retry" as const; },
    });
    expect(calls).toBe(2);
    expect(result.done.has("T-1")).toBe(true);
    expect(result.restart).toBeUndefined();
  });

  it("amend 回 paused 或 failed 時照一般的暫停／失敗處理", async () => {
    const paused = await scheduleLanes([task("T-1")], new Set(), Infinity, {
      async start(): Promise<LaneOutcome> { return { kind: "amend", request: "{}" }; },
      async merge() { return "merged" as const; },
      async amend() { return { kind: "paused" as const, reason: "修補達上限" }; },
    });
    expect(paused.paused).toBe("修補達上限");
    const failed = await scheduleLanes([task("T-1")], new Set(), Infinity, {
      async start(): Promise<LaneOutcome> { return { kind: "amend", request: "{}" }; },
      async merge() { return "merged" as const; },
      async amend() { return { kind: "failed" as const, reason: "重試達上限", category: "retry_limit" }; },
    });
    expect(failed.failed?.reason).toBe("重試達上限");
  });

  it("沒有提供 hooks.amend 時，amend 結果視為失敗", async () => {
    const result = await scheduleLanes([task("T-1")], new Set(), Infinity, {
      async start(): Promise<LaneOutcome> { return { kind: "amend", request: "{}" }; },
      async merge() { return "merged" as const; },
    });
    expect(result.failed?.reason).toMatch(/修補/);
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run src/lanes.test.ts -t "修補請求"`
Expected: FAIL（型別錯誤或 `restart` 為 undefined）

- [ ] **Step 3: 實作排程**

`src/lanes.ts`：

1. `LaneOutcome` 加一種，並新增 `AmendResolution`：

```ts
export type LaneOutcome =
  | { kind: "done" }
  | { kind: "failed"; reason: string; category?: string }
  | { kind: "paused"; reason: string }
  /** 車道裡的任務寫了 .flow/amend-request.json：request 是原文，由呼叫端判斷 */
  | { kind: "amend"; request: string };

/** 處理修補請求的結果：retry＝請求不合格，同一車道帶著回饋重跑；restart＝已插入修補任務，停止開新車道，讓呼叫端重新排程 */
export type AmendResolution = "retry" | "restart" | { kind: "failed"; reason: string; category?: string } | { kind: "paused"; reason: string };
```

2. `LaneHooks` 加：

```ts
  /** 處理車道提出的修補請求；沒提供就把請求視為失敗 */
  amend?(task: TaskItem, request: string): Promise<AmendResolution>;
```

3. `LaneResult` 加：

```ts
  /** 修補任務已插入：已在跑的車道收尾後停止，呼叫端要重新排程 */
  restart?: boolean;
```

4. `scheduleLanes` 迴圈裡，把 `if (outcome.kind === "failed") {...} else if (outcome.kind === "paused") {...} else {...}` 改成：

```ts
    if (outcome.kind === "amend") {
      const resolution: AmendResolution = hooks.amend
        ? await hooks.amend(task, outcome.request)
        : { kind: "failed", reason: `${task.id} 提出修補請求，但這個流程不支援修補` };
      if (resolution === "retry") {
        if (!stopped) launch(task);
      } else if (resolution === "restart") {
        stopped = true;
        result.restart = true;
      } else if (resolution.kind === "paused") {
        stopped = true;
        result.paused ??= resolution.reason;
      } else {
        stopped = true;
        result.failed ??= { task, reason: resolution.reason, category: resolution.category };
      }
    } else if (outcome.kind === "failed") {
```

（其餘 `paused` 與完成合併的分支維持原樣，接在後面。）

- [ ] **Step 4: 確認排程測試通過**

Run: `npx vitest run src/lanes.test.ts`
Expected: PASS（含既有測試）

- [ ] **Step 5: 引擎接線**

`src/engine.ts`：

1. 匯入改為 `import { doneSet, readyTasks, scheduleLanes, type AmendResolution, type LaneOutcome } from "./lanes.js";`

2. `driveLane` 的迴圈開頭（`for (;;) {` 之後、`if (lane.stage === "verify")` 之前）加：

```ts
      const requestFile = join(flowDir(lane.id), "amend-request.json");
      if (existsSync(requestFile)) return { kind: "amend", request: readFileSync(requestFile, "utf8") };
```

3. 在 `mergeLane` 之後加：

```ts
/**
 * 處理車道提出的修補請求（請求者是這條車道的任務）：
 * 不合格就讓車道帶著回饋重跑；達上限暫停；套用後丟棄請求者的車道（分支回收），之後從最新的分支重做。
 */
async function amendFromLane(ref: { run: FlowRun }, task: TaskItem, request: string): Promise<AmendResolution> {
  const id = laneId(ref.run.id, task.id);
  const lane = getRun(id);
  if (!lane) throw new Error(`找不到車道 ${id} 的紀錄`);
  const tasks = loadOrderedTasks(ref.run);
  const result = applyAmendRequest(ref.run, request, task.id, tasks, doneSet(tasks, ref.run.taskIndex, ref.run.doneTasks));
  rmSync(join(flowDir(id), "amend-request.json"), { force: true });
  if (result.kind === "invalid") {
    const retried = retry({ ...lane, stage: "implement" }, `${task.id}:amend`, result.reason, "implement", "amend_invalid");
    saveRun(retried);
    if (retried.stage === "failed") return { kind: "failed", category: "retry_limit", reason: retried.failureReason ?? "修補請求重試達上限" };
    return "retry";
  }
  if (result.kind === "limit") {
    writeFileSync(join(flowDir(id), "feedback.md"), `# 修補請求未被接受\n\n${amendLimitFeedback(result.reason)}\n`);
    const reason = `${task.id} 的修補請求被拒絕：${result.reason}；請檢查 ${join(flowDir(id), "feedback.md")} 後 resume，或用 replan 調整計畫`;
    saveRun({ ...lane, stage: "paused", pausedStage: "implement", pauseReason: reason });
    return { kind: "paused", reason };
  }
  ref.run = result.run;
  await cleanupTempWorktrees(id);
  await removeWorktree(projectRoot(), worktreeDir(id)).catch(() => rmSync(worktreeDir(id), { recursive: true, force: true }));
  await git(projectRoot(), "branch", "-D", lane.branch).catch(() => {});
  return "restart";
}
```

4. `implementLanes`：`scheduleLanes` 的 hooks 加 `amend: (task, request) => amendFromLane(ref, task, request),`；在 `if (result.paused) throw new QuotaPause(result.paused);` 之後加：

```ts
  // 修補任務已插入：不改階段直接回傳，advance() 會重新進入實作階段，讀到新的任務清單
  if (result.restart) return ref.run;
```

- [ ] **Step 6: 型別檢查與全部測試**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS。`amendFromLane` 沒有專屬的 git 整合測試；若要補，仿 `src/parallelEngine.test.ts` 建兩個獨立任務的 run（`taskConcurrency` 不設）、讓其中一個任務的腳本寫出請求，斷言 `tasks.ordered.json` 多出修補任務、`getRun(laneId(...))` 的 worktree 已移除，作為額外一個 `it`；實作時若這個測試耗時超過 30 秒就保持手動驗證並在 PR 描述註明。

- [ ] **Step 7: Commit**

```bash
git add src/lanes.ts src/lanes.test.ts src/engine.ts
git commit -m "修補任務：平行模式的車道可提出修補請求

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prompt、README 與整體驗證

**Files:**
- Modify: `prompts/implement-tests.md`、`prompts/implement-code.md`、`prompts/implement-direct.md`
- Modify: `README.md`
- Test: `src/prompts.test.ts`（既有，不改）

**Interfaces:**
- Consumes: Task 1–4 的行為。
- Produces: 使用者可見文件。

- [ ] **Step 1: 在三個 prompt 的 `<constraints>` 前加 `<amend>` 區段**

在 `prompts/implement-tests.md`、`prompts/implement-code.md`、`prompts/implement-direct.md` 各自的 `<constraints>` 標籤之前，加入同一段（靜態文字，不含 `{{變數}}`，所以不用改 engine 的 `renderPrompt` 呼叫）：

```
<amend>
若完成這個任務**必須改變已合併的前面任務的行為**（不是你自己的實作不足），不要順手去改它的檔案。改為寫入 .flow/amend-request.json，然後停止這個任務的其他工作：

```json
{ "target": "要修補的已合併任務 id，例如 T-1", "reason": "為什麼必須改它", "files": ["預計修改的檔案"], "acceptance": ["修補後應成立、可驗證的條件"] }
```

外部流程會檢查格式、次數上限與目標是否已合併；通過後會插入一個修補任務先做，你的任務之後再從最新的程式碼重做。同一個任務最多只能被修補有限次，沒有必要時不要提出。
</amend>
```

- [ ] **Step 2: 確認 prompt 測試**

Run: `npx vitest run src/prompts.test.ts`
Expected: PASS

- [ ] **Step 3: 更新 README**

Run: `grep -n "planArbiter\|reviewConcurrency\|agentRunsPerTask" README.md` 找到 `flow.config.json` 欄位說明的位置，在 `agentRunsPerTask` 同一區塊加：

```
- `maxAmendments`（預設 2）：同一個已合併任務最多被後面的任務要求修補幾次，超過就暫停等人處理。
```

再在 README 描述實作階段流程的段落（用 `grep -n "任務審查\|taskConcurrency\|平行" README.md` 找）加一段：

```
**修補任務**：後面的任務發現必須改變已合併任務的行為時，agent 會寫 `.flow/amend-request.json`。引擎檢查格式、目標是否已合併與次數上限後，插入一個依賴該任務的修補任務（`kind: "amend"`，走完整的紅燈、綠燈、任務審查、任務驗證），請求者丟棄半成品，等修補合併後從最新的分支重做；修補任務會讓 agent 執行次數上限加上 `agentRunsPerTask`（明確指定 `--max-agent-runs` 時不加）。達到 `maxAmendments` 時 run 暫停，`resume` 前請檢查 `.flow/feedback.md`。
```

- [ ] **Step 4: 整體驗證**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: 全部通過。

- [ ] **Step 5: Commit**

```bash
git add prompts/implement-tests.md prompts/implement-code.md prompts/implement-direct.md README.md
git commit -m "修補任務：prompt 說明與 README

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec 覆蓋**：請求出口與 schema（Task 1）；程式檢查四項與冪等（Task 2；預算改為加碼，Task 3 `applyAmendRequest`）；插入任務與驗收條件（Task 2、3）；順序與平行執行（Task 3、4）；新狀態欄位（Task 1）；錯誤與邊界：無效→`retry`、上限→`QuotaPause`、修補任務失敗沿用既有流程、不可指向自己（Task 2）、冪等 resume（Task 2 的 `applied`＋Task 3 的寫檔順序）；測試清單（Task 1–4）；prompt 與 README（Task 5）。spec 內「修補任務不可指向修補中的自己」由 `target === requesterId` 與「target 必須已合併」共同保證。`roles.test.ts` 不需修改：角色輪替用 `taskPosition`，修補任務與一般任務走同一條路徑。
- **Placeholder 掃描**：無 TBD；Task 4 Step 6 的車道整合測試標明為選做並說明取捨。
- **型別一致**：`decideAmend`／`AmendDecision`／`AmendInput`（Task 2）與 Task 3 的使用一致；`applyAmendRequest` 回傳 `AmendApplied` 在 Task 3、4 一致；`AmendResolution`、`LaneOutcome.amend`、`LaneResult.restart` 在 Task 4 的 lanes.ts、測試與 engine 一致；重試分類 `amend_invalid` 在 Task 1 定義，Task 3、4 使用。
