# 重試前短發散 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一個任務連續因測試／實作關卡失敗時，在下一次寫檔前先跑 2 到 3 個隔離診斷分支加一次評審，把程式驗證過的結論寫進 feedback，打斷同一條路重試。

**Architecture:** 觸發與 frame 選擇是純函式（`src/diverge.ts`）。`implementStage` 在紅燈／綠燈 `agentStep` 之前呼叫 `maybeDiverge`：先記下 HEAD、寫 stamp、依序跑分支、再跑評審、每次結束 `resetTo(before)`、追加 feedback。關卡判斷不看評審的 `action`。產物放在 worktree 外的 `diverge.json`，同時記下發散當下 `retries.jsonl` 的筆數（`retriesSeen`），連續合格只算那之後新增的，避免同一段失敗發散兩次。TDD 預設主路徑是綠燈退回測試後才發散，不是 `code` 上 `attempts === 2`。

**Tech Stack:** Node.js 22、TypeScript、Zod、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-02-retry-diverge-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。
- 關卡判斷只看程式能檢查的事實，不依評審 `action` 改 `taskPhase`、不自動 `replan`、不暫停。
- 規則「審查者不能是最後的作者」不能放寬；評審排除卡住的寫檔角色（`lastWriter ?? lastTestsAuthor`，都空時用 `taskAgents` 的 `code`／`tests`），單一 agent 時才退回自己。
- 每次分支／評審後用 `resetTo(before)`，不用 `discardChanges`，並還原 `.flow/` 的鎖定計畫檔、`feedback.md`、`red-output.txt`。`tests_not_red` 不觸發發散。
- 改變使用者看得到的行為時，同一個 commit 要更新 `README.md`。
- 不使用環境變數；設定放 `flow.config.json` 的 `diverge`。
- 新增 run 資料檔要同步 `dump.ts` 的 `RUN_ENTRIES`。
- 不安裝第三方 ADHD skill，不在 adapter 層關工具。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `src/diverge.ts` | Create | `shouldDiverge`、`consecutiveEligible`、`divergeExclude`、`selectFrames`、`divergeStamp`、`formatDivergeFeedback` |
| `src/diverge.test.ts` | Create | 連續合格、退回測試、去重、`retriesSeen`、排除角色、frame 種子、feedback 文字 |
| `src/schemas.ts` | Modify | Task 1：`RepoConfig.diverge`、分支／評審／紀錄的 zod；Task 2：`ModelStage` 與 `stageStrength` 加 `diverge` |
| `src/schemas.test.ts` | Modify | 設定預設與拒絕條件 |
| `src/paths.ts` | Modify | `divergePath` |
| `src/dump.ts` | Modify | `RUN_ENTRIES` 加 `diverge.json` |
| `src/roles.ts` | Modify | `divergeCritic` |
| `src/roles.test.ts` | Modify | 評審排除最後寫檔者 |
| `src/modelSelection.ts` | Modify | 預設 `diverge: "low"`，步驟名對應到階段 |
| `src/modelSelection.test.ts` | Modify | 階段數改 12、步驟對應 |
| `prompts/diverge-branch.md` | Create | 分支 prompt |
| `prompts/diverge-critic.md` | Create | 評審 prompt |
| `src/prompts.test.ts` | Modify | 新變數與斷言 |
| `src/engine.ts` | Modify | `maybeDiverge`，接在紅燈／綠燈寫檔前 |
| `src/engine.test.ts` | Modify | 所有 implement helper 關閉 diverge；主測退回測試後發散 |
| `src/cli.ts` | Modify | `config doctor` 印出 diverge |
| `README.md` | Modify | 設定表與行為說明 |
| `AGENTS.md` | Modify | run 目錄列出 `diverge.json` |

---

### Task 1: 設定、schema 與觸發純函式

**Files:**
- Create: `src/diverge.ts`
- Create: `src/diverge.test.ts`
- Modify: `src/schemas.ts`（`RepoConfig.diverge`、發散 zod；`ModelStage` 留到 Task 2，這個 commit 才能單獨通過 typecheck）
- Modify: `src/schemas.test.ts`

**Interfaces:**
- Produces:
  - `DivergeFrame = "acceptance" | "split" | "invert"`
  - `DIVERGE_CATEGORIES = ["tests_not_green", "tests_invalid", "tests_not_written"]`
  - `divergeStamp(taskId: string, phase: "tests" | "code", attempts: number, testsRedos: number): string`
  - `consecutiveEligible(retries, key, since?): number`（只算 `retries.slice(since)`）
  - `divergeExclude(opts): string | undefined`
  - `shouldDiverge(opts: DivergeTrigger): boolean`
  - `selectFrames(seed: string, n: number): DivergeFrame[]`
  - `formatDivergeFeedback(pick: DivergePick): string`
  - `RepoConfig.diverge: { enabled: boolean; after: number; branches: number }`
  - `DivergeBranch`、`DivergePick`、`DivergeRecord`（zod；`DivergeRecord.retriesSeen` 為發散當下的 retries 筆數）

- [ ] **Step 1: 寫失敗的 schema 測試**

在 `src/schemas.test.ts` 末端加入：

```ts
describe("RepoConfig.diverge", () => {
  const defaults = { enabled: true, after: 2, branches: 3 };

  it("沒寫時用預設，只寫一個子欄位時其餘補上預設", () => {
    expect(RepoConfig.parse({}).diverge).toEqual(defaults);
    expect(RepoConfig.parse({ diverge: { enabled: false } }).diverge).toEqual({ ...defaults, enabled: false });
  });

  it("after 小於 1、branches 不是 2 或 3、或寫了未知子欄位時拒絕", () => {
    expect(RepoConfig.safeParse({ diverge: { after: 0 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { branches: 1 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { branches: 4 } }).success).toBe(false);
    expect(RepoConfig.safeParse({ diverge: { frames: 3 } }).success).toBe(false);
  });
});

describe("DivergePick", () => {
  it("pick 與 action 必須是允許的值", () => {
    expect(DivergePick.safeParse({
      pick: "acceptance", action: "keep_fixing", rationale: "對上驗收", nextStep: "改斷言",
    }).success).toBe(true);
    expect(DivergePick.safeParse({
      pick: "other", action: "keep_fixing", rationale: "x", nextStep: "y",
    }).success).toBe(false);
  });
});
```

並在同一個 describe 後加一筆 `DivergeRecord.safeParse({ stamp: "T-1:code:2:0", status: "done", key: "T-1:code", frames: ["acceptance"], retriesSeen: 2 }).success` 為 true。

檔案頂端的既有 import 要加上 `DivergePick`、`DivergeRecord`（ESM 不能用 `require`）。

- [ ] **Step 2: 確認 schema 測試失敗**

Run: `npx vitest run src/schemas.test.ts -t "RepoConfig.diverge"`
Expected: FAIL，`RepoConfig` 還沒有 `diverge`。

- [ ] **Step 3: 在 schemas 加入型別與設定**

`RepoConfig` 在 `planReviewLayers` 後面加入：

```ts
  diverge: z.strictObject({
    enabled: z.boolean().default(true),
    after: z.number().int().min(1).default(2),
    branches: z.number().int().min(2).max(3).default(3),
  }).default({ enabled: true, after: 2, branches: 3 }),
```

在 `ConsistentReviewResult` 附近加入：

```ts
export const DivergeFrame = z.enum(["acceptance", "split", "invert"]);
export type DivergeFrame = z.infer<typeof DivergeFrame>;

export const DivergeBranch = z.object({
  frame: DivergeFrame,
  hypothesis: z.string().trim().min(1),
  nextStep: z.string().trim().min(1),
});
export type DivergeBranch = z.infer<typeof DivergeBranch>;

export const DivergePick = z.object({
  pick: DivergeFrame,
  action: z.enum(["keep_fixing", "rewrite_tests", "split_task"]),
  rationale: z.string().trim().min(1),
  nextStep: z.string().trim().min(1),
});
export type DivergePick = z.infer<typeof DivergePick>;

export const DivergeRecord = z.object({
  stamp: z.string().min(1),
  status: z.enum(["running", "done", "skipped"]),
  key: z.string().min(1),
  frames: z.array(DivergeFrame),
  branches: z.array(DivergeBranch).default([]),
  pick: DivergePick.optional(),
  reason: z.string().optional(),
  // 發散當下 retries.jsonl 的筆數：之後連續合格只算這之後新增的，同一段失敗不會再觸發第二次
  retriesSeen: z.number().int().min(0).optional(),
});
export type DivergeRecord = z.infer<typeof DivergeRecord>;
```

- [ ] **Step 4: 確認 schema 測試通過**

Run: `npx vitest run src/schemas.test.ts`
Expected: PASS。

- [ ] **Step 5: 寫失敗的 diverge 純函式測試**

建立 `src/diverge.test.ts`：

```ts
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
```

- [ ] **Step 6: 確認純函式測試失敗**

Run: `npx vitest run src/diverge.test.ts`
Expected: FAIL，`src/diverge.ts` 不存在。

- [ ] **Step 7: 實作 `src/diverge.ts`**

```ts
import { shuffled } from "./roles.js";
import type { DivergeFrame, DivergePick } from "./schemas.js";

export const DIVERGE_CATEGORIES = ["tests_not_green", "tests_invalid", "tests_not_written"] as const;
export const DIVERGE_FRAMES: DivergeFrame[] = ["acceptance", "split", "invert"];

export function divergeStamp(taskId: string, phase: "tests" | "code", attempts: number, testsRedos: number): string {
  return `${taskId}:${phase}:${attempts}:${testsRedos}`;
}

export interface DivergeTrigger {
  enabled: boolean;
  after: number;
  phase: "tests" | "code";
  taskId: string;
  attempts: Record<string, number>;
  testsRedos?: number;
  retries: { key: string; category: string }[];
  lastStamp?: string;
  /** 上一次發散當下的 retries 筆數；連續合格只算這之後新增的 */
  since?: number;
}

export interface DivergeExcludeOpts {
  phase: "tests" | "code";
  testsRedos?: number;
  lastWriter?: string;
  lastTestsAuthor?: string;
  testsAgent: string;
  codeAgent: string;
}

function lastFor(retries: DivergeTrigger["retries"], key: string): string | undefined {
  return [...retries].reverse().find((item) => item.key === key)?.category;
}

function eligible(category: string | undefined): boolean {
  return category !== undefined && (DIVERGE_CATEGORIES as readonly string[]).includes(category);
}

/** 同一 key 從最新往回數的連續合格筆數；其他 key 略過，不合格分類中斷；只看 since 之後新增的 */
export function consecutiveEligible(retries: DivergeTrigger["retries"], key: string, since = 0): number {
  let n = 0;
  for (const item of retries.slice(since).reverse()) {
    if (item.key !== key) continue;
    if (!eligible(item.category)) break;
    n++;
  }
  return n;
}

/** 綠燈失敗／redoTests 不會留下 lastWriter；redoTests 還會清掉 lastTestsAuthor，所以空時改看 taskAgents */
export function divergeExclude(opts: DivergeExcludeOpts): string | undefined {
  const bounced = opts.phase === "tests" && (opts.testsRedos ?? 0) > 0;
  const role = bounced || opts.phase === "code" ? opts.codeAgent : opts.testsAgent;
  return opts.lastWriter ?? opts.lastTestsAuthor ?? role;
}

export function shouldDiverge(opts: DivergeTrigger): boolean {
  if (!opts.enabled) return false;
  const attempts = opts.attempts[`${opts.taskId}:${opts.phase}`] ?? 0;
  const stamp = divergeStamp(opts.taskId, opts.phase, attempts, opts.testsRedos ?? 0);
  if (opts.lastStamp === stamp) return false;
  // 只在連續合格剛好達到門檻的那一次發散，之後同一 streak 不再付第二次錢
  if (consecutiveEligible(opts.retries, `${opts.taskId}:${opts.phase}`, opts.since ?? 0) === opts.after) return true;
  // 剛從綠燈退回測試、tests 還沒自己失敗過；testsRedos 每增加一次才算新的一輪。
  // 發散後 since 會移到目前筆數，所以回到 code 階段時 T-1:code 的舊失敗不會再湊滿門檻
  if (opts.phase === "tests" && attempts === 0 && (opts.testsRedos ?? 0) > 0
    && lastFor(opts.retries, `${opts.taskId}:code`) === "tests_invalid") return true;
  return false;
}

export function selectFrames(seed: string, n: number): DivergeFrame[] {
  return shuffled(DIVERGE_FRAMES, `${seed}:frames`).slice(0, n);
}

export function formatDivergeFeedback(pick: DivergePick): string {
  return [
    "",
    "## 發散結論",
    "",
    `選了 \`${pick.pick}\`（建議 ${pick.action}）。`,
    "",
    pick.rationale,
    "",
    `下一動：${pick.nextStep}`,
    "",
  ].join("\n");
}
```

`roles.ts` 已匯出 `shuffled`，這裡可以重用，種子穩定。

- [ ] **Step 8: 確認純函式測試通過**

Run: `npx vitest run src/diverge.test.ts src/schemas.test.ts`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/diverge.ts src/diverge.test.ts src/schemas.ts src/schemas.test.ts
git commit -m "$(cat <<'EOF'
新增重試前短發散的觸發判斷與設定欄位

EOF
)"
```

---

### Task 2: 選模階段與評審人選

**Files:**
- Modify: `src/schemas.ts`（`ModelStage`、`RepoConfig.modelSelection.stageStrength`）
- Modify: `src/modelSelection.ts`
- Modify: `src/modelSelection.test.ts`
- Modify: `src/roles.ts`
- Modify: `src/roles.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RepoConfig.diverge`
- Produces: `stageOfStep("T-1-diverge-acceptance") === "diverge"`、`DEFAULT_STAGE_STRENGTH.diverge === "low"`、`divergeCritic(cycle, excluded, seed): string`（`excluded` 由 Task 1 的 `divergeExclude` 算出，不要直接塞 `lastWriter`／`lastTestsAuthor`）

- [ ] **Step 1: 寫失敗的選模與角色測試**

在 `src/modelSelection.test.ts` 的「階段強度」把 `toHaveLength(11)` 改成 `toHaveLength(12)`，並加：

```ts
    expect(all.diverge).toEqual({ strength: "low", custom: false });
```

在同一個檔案加：

```ts
  it("發散步驟對應 diverge 階段", () => {
    expect(stageOfStep("T-1-diverge-acceptance")).toBe("diverge");
    expect(stageOfStep("T-1-diverge-critic")).toBe("diverge");
  });
```

在 `src/roles.test.ts` 的 import 加上 `divergeCritic`，並在「角色規則」加入：

```ts
  it("發散評審不是最後寫檔的 agent，單一 agent 時退回自己", () => {
    for (const s of seeds) {
      expect(divergeCritic(three, "codex", s)).not.toBe("codex");
      expect(divergeCritic(two, "claude", s)).toBe("codex");
    }
    expect(divergeCritic(["claude"], "claude", "x")).toBe("claude");
  });
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run src/modelSelection.test.ts src/roles.test.ts -t "發散"`
Expected: FAIL，`stageOfStep` 不認得發散步驟、`divergeCritic` 不存在。`toHaveLength(12)` 也會 FAIL。

- [ ] **Step 3: 實作對應與人選**

`src/schemas.ts` 的 `ModelStage`（單行 `z.enum`）末端加 `"diverge"`：

```ts
export const ModelStage = z.enum(["spec", "plan", "planReview", "planFix", "planArbiter", "taskTests", "taskCode", "taskReview", "taskFix", "fix", "review", "diverge"]);
```

`RepoConfig.modelSelection.stageStrength` 的 `strictObject` 加 `diverge: ModelStrength.optional()`。

`src/modelSelection.ts` 的 `DEFAULT_STAGE_STRENGTH` 加 `diverge: "low"`。

`stageOfStep` 在 task 正規式之後、stage map 之前加入：

```ts
  if (/^T-\d+-diverge(?:-[a-z]+)?$/.test(step)) return "diverge";
```

`escalation` 對 `diverge` 回傳 `0`（寫在 `planArbiter` 那行旁邊）：

```ts
  if (stage === "planArbiter" || stage === "diverge") return 0;
```

`src/roles.ts` 在 `pick` 之後加入：

```ts
/** 發散評審不能是這次任務最後的寫檔者；只有一家時退回自己 */
export const divergeCritic = (cycle: string[], lastWriter: string | undefined, seed: string) =>
  pick(cycle, `${seed}:diverge-critic`, lastWriter ? [lastWriter] : []);
```

- [ ] **Step 4: 確認測試與型別通過**

Run: `npx vitest run src/modelSelection.test.ts src/roles.test.ts && pnpm run typecheck`
Expected: PASS。`ModelStage` 與 `DEFAULT_STAGE_STRENGTH` 在同一個 commit 補齊，所以 typecheck 可以直接跑。

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/modelSelection.ts src/modelSelection.test.ts src/roles.ts src/roles.test.ts
git commit -m "$(cat <<'EOF'
發散步驟用 low 強度，評審避開最後寫檔者

EOF
)"
```

---

### Task 3: 分支與評審 prompt

**Files:**
- Create: `prompts/diverge-branch.md`
- Create: `prompts/diverge-critic.md`
- Modify: `src/prompts.test.ts`

**Interfaces:**
- Consumes: `renderPrompt(name, vars)`；新變數 `frame`、`framePrompt`、`task`、`acceptance`、`feedback`、`category`、`branches`
- Produces: 兩份 prompt 都有獨立 `<role>`、`<reply_format>`、交接空陣列；分支禁止評估、評審只從給定分支裡選

- [ ] **Step 1: 在 `src/prompts.test.ts` 的 `vars` 加上新變數**

```ts
  frame: "acceptance",
  framePrompt: "假設實作方向對，但測試沒對上驗收條件。",
  feedback: "測試仍未通過",
  category: "tests_not_green",
  branches: "[]",
```

在 `describe("prompts")` 末端加入：

```ts
  it("diverge-branch 禁止評估其他方案，只寫分支 JSON", () => {
    const text = renderPrompt("diverge-branch", vars);
    expect(text).toContain("發散分支");
    expect(text).toContain(vars.framePrompt);
    expect(text).toContain(".flow/diverge-branch.json");
    expect(text).toContain("不要評估、排序或比較其他方案");
    expect(text).not.toContain("diverge-pick.json");
  });

  it("diverge-critic 只從給定分支裡選一個", () => {
    const text = renderPrompt("diverge-critic", vars);
    expect(text).toContain("發散評審");
    expect(text).toContain(".flow/diverge-pick.json");
    expect(text).toContain("只能選 inputs 裡出現的 frame");
    expect(text).not.toContain("diverge-branch.json");
  });
```

先加 `vars`、再建 prompt 檔：反過來的話，既有的「每個 prompt 都有角色」測試會因為 `renderPrompt` 少了變數而 FAIL。

- [ ] **Step 2: 寫兩個 prompt**

`prompts/diverge-branch.md`：

```md
<role>
你是發散分支，只從指定的認知框架重問這個卡住的任務。你不寫程式、不跑測試、不評估其他方案。
</role>

<context>
目前的工作目錄就是專案（agentflowctl 為這次任務建立的專用 git worktree）。
</context>

<handoff>
先閱讀 .flow/handoff-context.md，處理與本階段有關的待辦事項。完成時寫入 .flow/handoff-response.json；即使沒有事項也必須寫出空陣列：

```json
{ "newIssues": [], "dispositions": [] }
```

這一步的交接不會被記進帳本，照上面寫出空陣列即可，不要放事項。

新增事項格式：{ "kind": "action 或 info", "summary": "具體問題", "evidence": "檔案位置或檢查證據", "targetStage": "plan 或 code" }。
處置格式：{ "id": "既有事項 ID", "status": "proposed_resolved、resolved 或 accepted", "reason": "具體處理理由", "evidence": "檔案、commit 或檢查結果" }。只有「待處理事項」（action）可以處置：撰寫者只能用 proposed_resolved 提出修正；審查者可以用 resolved 或 accepted 結案。「參考資訊」（info）只供參考，不要放進 dispositions。重要疑慮必須放在這份檔案，不能只寫在回覆的 <concerns>。
</handoff>

<frame>
{{frame}}
</frame>

<frame_prompt>
{{framePrompt}}
</frame_prompt>

<task>
```json
{{task}}
```
</task>

<acceptance>
```json
{{acceptance}}
```
</acceptance>

<inputs>
- 最近一次失敗分類：{{category}}
- .flow/feedback.md（可能不存在）：
{{feedback}}
- 只讀與這個任務直接相關的測試或實作，不要通讀整個倉庫。
</inputs>

<steps>
1. 只用上面的 frame 重問這個任務為什麼卡住。
2. 寫出一個假設，以及依這個假設的下一動。
3. 把結果寫入 .flow/diverge-branch.json。
</steps>

<output_format>
寫入 .flow/diverge-branch.json：

```json
{
  "frame": "{{frame}}",
  "hypothesis": "一句話假設",
  "nextStep": "下一動的具體指示"
}
```

`frame` 必須與上面的 frame 完全相同。
</output_format>

<constraints>
- 不要評估、排序或比較其他方案。
- 只能寫入 .flow/diverge-branch.json 與 .flow/handoff-response.json，不可修改規格、計畫、測試或產品程式。
- 不要執行 git commit。
</constraints>

<reply_format>
完成後，回覆的最後必須附上以下 XML 中繼資料（只附一次，標籤名稱不可更改）：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>一兩句說明這次做了什麼；blocked 時說明卡在哪裡</summary>
  <files_changed>
    <file>每個新增或修改的檔案路徑各一行</file>
  </files_changed>
  <concerns>對需求、規格、計畫或測試的疑慮；沒有就留空</concerns>
</result>
```
</reply_format>
```

`prompts/diverge-critic.md`：

```md
<role>
你是發散評審，只根據已經隔離產出的分支做選擇。你不寫程式、不發明新的 frame。
</role>

<context>
目前的工作目錄就是專案（agentflowctl 為這次任務建立的專用 git worktree）。
</context>

<handoff>
先閱讀 .flow/handoff-context.md，處理與本階段有關的待辦事項。完成時寫入 .flow/handoff-response.json；即使沒有事項也必須寫出空陣列：

```json
{ "newIssues": [], "dispositions": [] }
```

這一步的交接不會被記進帳本，照上面寫出空陣列即可，不要放事項。

新增事項格式：{ "kind": "action 或 info", "summary": "具體問題", "evidence": "檔案位置或檢查證據", "targetStage": "plan 或 code" }。
處置格式：{ "id": "既有事項 ID", "status": "proposed_resolved、resolved 或 accepted", "reason": "具體處理理由", "evidence": "檔案、commit 或檢查結果" }。只有「待處理事項」（action）可以處置：撰寫者只能用 proposed_resolved 提出修正；審查者可以用 resolved 或 accepted 結案。「參考資訊」（info）只供參考，不要放進 dispositions。重要疑慮必須放在這份檔案，不能只寫在回覆的 <concerns>。
</handoff>

<task>
```json
{{task}}
```
</task>

<acceptance>
```json
{{acceptance}}
```
</acceptance>

<inputs>
- 最近一次失敗分類：{{category}}
- 各分支（JSON 陣列；你只能從這裡選）：
{{branches}}
- .flow/feedback.md（可能不存在）：
{{feedback}}
</inputs>

<steps>
1. 依可行性與是否解釋得了這次失敗，從 inputs 的分支裡選一個。
2. 寫出選擇理由，以及給下一次寫測試或實作的下一動。
3. 把結果寫入 .flow/diverge-pick.json。
</steps>

<output_format>
寫入 .flow/diverge-pick.json：

```json
{
  "pick": "acceptance",
  "action": "keep_fixing",
  "rationale": "為什麼選這個分支",
  "nextStep": "下一動的具體指示"
}
```

`pick` 只能選 inputs 裡出現的 frame。`action` 只能是 `keep_fixing`、`rewrite_tests`、`split_task`。
</output_format>

<constraints>
- 只能寫入 .flow/diverge-pick.json 與 .flow/handoff-response.json，不可修改規格、計畫、測試或產品程式。
- 不要執行 git commit。
</constraints>

<reply_format>
完成後，回覆的最後必須附上以下 XML 中繼資料（只附一次，標籤名稱不可更改）：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>一兩句說明這次做了什麼；blocked 時說明卡在哪裡</summary>
  <files_changed>
    <file>每個新增或修改的檔案路徑各一行</file>
  </files_changed>
  <concerns>對需求、規格、計畫或測試的疑慮；沒有就留空</concerns>
</result>
```
</reply_format>
```

兩個角色開頭必須不同（「發散分支」vs「發散評審」），既有「每份 prompt 的角色都不一樣」才會過。

- [ ] **Step 3: 確認 prompt 測試通過**

Run: `npx vitest run src/prompts.test.ts`
Expected: PASS，包含既有每個 prompt 的 `<role>`／`<reply_format>` 檢查。

- [ ] **Step 4: Commit**

```bash
git add prompts/diverge-branch.md prompts/diverge-critic.md src/prompts.test.ts
git commit -m "$(cat <<'EOF'
新增發散分支與評審 prompt

EOF
)"
```

只改 prompt 與對應測試，不更新 README。

---

### Task 4: engine 接上、產物放 run 目錄

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/dump.ts`
- Modify: `src/engine.ts`
- Modify: `src/engine.test.ts`
- Modify: `src/dump.test.ts`（可選；若現有「缺檔」測試因 `RUN_ENTRIES` 多一項而失敗再補）

**Interfaces:**
- Consumes: `shouldDiverge`、`divergeExclude`、`selectFrames`、`formatDivergeFeedback`、`divergeCritic`、`taskAgents`、`DivergeBranch`、`DivergePick`、`DivergeRecord`、`renderPrompt("diverge-branch" | "diverge-critic", vars)`
- Produces: `divergePath(id)`；`implementStage` 在 `tests`／`code` 寫檔前呼叫 `maybeDiverge`；每次分支／評審後 `resetTo(before)`；`kind: "write"` 跑分支、`kind: "review"` 跑評審

- [ ] **Step 1: 先讓既有 engine 測試不受影響**

在 `src/engine.test.ts` **所有會走到 implement 的** `flow.config.json` 寫入加上 `diverge: { enabled: false }`：`implementRun`、`greenRun`、`laneFlowRun`，以及同檔其他直接 `JSON.stringify({ agents, cycle, ... })` 且 `stage: "implement"` 的測試。不要只改兩個 helper。這一步要先做，預設 `enabled: true` 之後，退回測試或連續合格會多出 4 次 agent 呼叫，既有 `maxAgentRuns` 斷言會碎。

例如 `implementRun` 的 config：

```ts
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", implementer] }])),
    cycle: ["a", "b"], install: "true", ...(test === null ? {} : { test }), checks: [],
    diverge: { enabled: false },
  }));
```

`greenRun`、`laneFlowRun` 同樣加 `diverge: { enabled: false }`。

- [ ] **Step 2: 寫失敗的 engine 測試**

在 `src/engine.test.ts` 靠近綠燈測試的地方加入（沿用檔案既有的 `root`、`advance`、`worktreeDir`、`flowDir`、`listRetries`、`agentRuns`，`runDir` 若尚未從 `./paths.js` import 就補上）。

`advance()` 會一路跑到 `done`／`failed`／`paused`，不會做完一步就停；它只在**每一步開始前**檢查 `maxAgentRuns`。既有 `greenRun` 靠 `maxAgentRuns: 1` 讓它在退回測試後停下。這裡照同樣做法：用 `maxAgentRuns` 控制每次 `advance` 剛好跑一個階段，發散的 3 到 4 次呼叫都在同一個階段內，不會被中途打斷。

```ts
describe("重試前短發散", () => {
  const divergeScript = join(root, "diverge-implementer.mjs");
  writeFileSync(divergeScript, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
if (prompt.includes("發散分支")) {
  const frame = /<frame>\\n(\\w+)/.exec(prompt)[1];
  writeFileSync(".flow/diverge-branch.json", JSON.stringify({ frame, hypothesis: "h-" + frame, nextStep: "n-" + frame }));
} else if (prompt.includes("發散評審")) {
  writeFileSync(".flow/diverge-pick.json", JSON.stringify({
    pick: "acceptance", action: "keep_fixing", rationale: "對上驗收", nextStep: "先改斷言再實作",
  }));
} else {
  const fb = existsSync(".flow/feedback.md") ? readFileSync(".flow/feedback.md", "utf8") : "";
  writeFileSync(".flow/saw-diverge.txt", fb);
  if (prompt.includes("<red_output>")) writeFileSync("stub.mjs", "export const n = 1;\\n");
  else writeFileSync("feature.test.mjs", "process.exit(1);\\n");
}
`);

  async function setup(id: string, extra: Record<string, unknown> = {}) {
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", divergeScript] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [],
      diverge: { enabled: true, after: 2, branches: 2 },
      ...extra,
    }));
    const wt = worktreeDir(id);
    await addWorktree(root, wt, "main", `flow/${id}`);
    const taskBase = await git(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "feature.test.mjs"), "process.exit(1);\n");
    const testsCommit = (await commitAll(wt, "test(T-1): 測試 [a]"))!;
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-2", description: "匯出 answer" }]));
    writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify([
      { id: "T-1", title: "元件", description: "新增元件", dependsOn: [], acceptance: ["AC-2"], tdd: true },
    ]));
    writeFileSync(join(flowDir(id), "red-output.txt"), "FAIL");
    return { taskBase, testsCommit, now: new Date().toISOString() };
  }

  const base = (id: string, o: { now: string; taskBase: string; testsCommit: string }) => ({
    id, baseBranch: "main" as const, branch: `flow/${id}`, requirement: "測試功能", stage: "implement" as const,
    autopilot: true, maxAgentRuns: 1, cycle: ["a", "b"] as string[], attempts: {},
    taskIndex: 0, taskBase: o.taskBase, testsCommit: o.testsCommit, createdAt: o.now, updatedAt: o.now,
  });
  /** failed（預算用完）的 run 再多給一步的額度 */
  const oneMoreStep = (run: FlowRun) => ({
    ...run, stage: "implement" as const, failedStage: undefined, failureCategory: undefined, failureReason: undefined,
    maxAgentRuns: agentRuns(run.id) + 1,
  });

  it("綠燈第二次失敗退回測試後，下一次寫測試前才發散；回到 code 階段不會再發散", async () => {
    const id = "f-diverge-redo";
    const o = await setup(id);
    // 真實序列：第一次綠燈失敗已經留下一筆 tests_not_green，這次是第二次，所以走 redoTests
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_not_green", attempt: 1, final: false });
    const first = await advance({ ...base(id, o), taskPhase: "code", attempts: { "T-1:code": 1 }, lastTestsAuthor: "a" });
    expect(first.taskPhase).toBe("tests");
    expect(first.testsRedos).toBe(1);
    expect(existsSync(join(runDir(id), "diverge.json"))).toBe(false);
    expect(agentRuns(id)).toBe(1);

    // 下一個階段：2 個分支 + 1 個評審 + 1 次寫測試
    const second = await advance(oneMoreStep(first));
    const record = JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8"));
    expect(record.status).toBe("done");
    expect(record.stamp).toBe("T-1:tests:0:1");
    expect(record.retriesSeen).toBe(2);
    expect(record.pick.pick).toBe("acceptance");
    expect(second.taskPhase).toBe("code");
    expect(agentRuns(id)).toBe(1 + 4);
    // 發散後的測試作者讀得到結論（之後 retry() 會覆寫 feedback.md，所以由腳本留證據）
    expect(readFileSync(join(flowDir(id), "saw-diverge.txt"), "utf8")).toContain("先改斷言再實作");

    // 回到 code 階段：T-1:code 仍有 tests_not_green + tests_invalid 兩筆，但都在 retriesSeen 之前，不能再發散
    const third = await advance(oneMoreStep(second));
    expect(agentRuns(id)).toBe(1 + 4 + 1);
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).stamp).toBe("T-1:tests:0:1");
    expect(third.stage).not.toBe("paused");
  });

  it("已有相同 stamp 且 done 時不重跑發散", async () => {
    const id = "f-diverge-resume";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(join(runDir(id), "diverge.json"), JSON.stringify({
      stamp: "T-1:tests:0:1", status: "done", key: "T-1:tests", frames: ["acceptance", "split"], retriesSeen: 1,
      branches: [], pick: { pick: "split", action: "split_task", rationale: "已做過", nextStep: "拆任務" },
    }));
    await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).pick.nextStep).toBe("拆任務");
    expect(agentRuns(id)).toBe(1); // 只有寫測試那一次
  });

  it("stamp 還是 running（中斷或評審額度暫停）時 resume 會重跑", async () => {
    const id = "f-diverge-running";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(join(runDir(id), "diverge.json"), JSON.stringify({
      stamp: "T-1:tests:0:1", status: "running", key: "T-1:tests", frames: ["acceptance", "split"], branches: [],
    }));
    await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(JSON.parse(readFileSync(join(runDir(id), "diverge.json"), "utf8")).status).toBe("done");
    expect(agentRuns(id)).toBe(4);
  });

  it("分支把 .flow/feedback.md 改掉、或留下 commit，評審與後續寫檔都看不到", async () => {
    const id = "f-diverge-isolation";
    const o = await setup(id);
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    writeFileSync(join(flowDir(id), "feedback.md"), "原本的回饋\n");
    const tamper = join(root, "diverge-tamper.mjs");
    writeFileSync(tamper, `import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const prompt = readFileSync(0, "utf8");
writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
if (prompt.includes("發散分支")) {
  const frame = /<frame>\\n(\\w+)/.exec(prompt)[1];
  writeFileSync(".flow/feedback.md", "被分支改掉");
  writeFileSync("leak.txt", "x");
  execFileSync("git", ["add", "-A"]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "leak"]);
  writeFileSync(".flow/diverge-branch.json", JSON.stringify({ frame, hypothesis: "h", nextStep: "n" }));
} else if (prompt.includes("發散評審")) {
  writeFileSync(".flow/diverge-pick.json", JSON.stringify({ pick: /"frame": "(\\w+)"/.exec(prompt)[1], action: "keep_fixing", rationale: "r", nextStep: "n" }));
} else {
  writeFileSync("feature.test.mjs", "process.exit(1);\\n");
}
`);
    writeFileSync(join(root, "flow.config.json"), JSON.stringify({
      agents: Object.fromEntries(["a", "b"].map((name) => [name, { adapter: "command", command: ["node", tamper] }])),
      cycle: ["a", "b"], install: "true", test: "node feature.test.mjs", checks: [], diverge: { enabled: true, after: 2, branches: 2 },
    }));
    const run = await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(existsSync(join(worktreeDir(id), "leak.txt"))).toBe(false);
    expect(await git(worktreeDir(id), "log", "--format=%s", "-1")).not.toBe("leak");
    expect(run.stage).not.toBe("paused");
    // 發散結論是追加在還原後的 feedback 之後
    expect(readFileSync(join(flowDir(id), "feedback.md"), "utf8")).not.toContain("被分支改掉");
  });

  it("關閉時完全不發散", async () => {
    const id = "f-diverge-off";
    const o = await setup(id, { diverge: { enabled: false } });
    addRetry(id, { key: "T-1:code", backTo: "implement", category: "tests_invalid", attempt: 1, final: false });
    await advance({ ...base(id, o), taskPhase: "tests", testsRedos: 1 });
    expect(existsSync(join(runDir(id), "diverge.json"))).toBe(false);
    expect(agentRuns(id)).toBe(1);
  });
});
```

`addRetry` 從 `./store.js` import（若檔案尚未 import 就加進既有那行）。

第一個測試走真實狀態機：先用 `maxAgentRuns: 1` 讓 `advance` 在退回測試後停下（跟 `greenRun` 一樣），再用 `oneMoreStep` 一次只放行一個階段。不要用 `taskPhase: "code"` 且 `attempts: { "T-1:code": 2 }` 當主測試，TDD 預設走不到那個狀態。第一個測試的 retries 要用「`tests_not_green` 一筆再加 `tests_invalid` 一筆」的真實序列，才抓得到 code 階段重複發散的問題。

- [ ] **Step 3: 確認 engine 測試失敗**

Run: `npx vitest run src/engine.test.ts -t "重試前短發散"`
Expected: FAIL，沒有 `diverge.json`、feedback 沒有「發散結論」。

- [ ] **Step 4: 加路徑與 dump**

`src/paths.ts` 在 `planArbitrationPath` 旁加入：

```ts
/** 重試前短發散的結果：放在 worktree 外，agent 改不到 */
export const divergePath = (id: string) => join(runDir(id), "diverge.json");
```

`src/dump.ts` 的 `RUN_ENTRIES` 加上 `"diverge.json"`。

- [ ] **Step 5: 實作 `maybeDiverge` 並接到 `implementStage`**

在 `src/engine.ts` import：

```ts
import { DivergeBranch, DivergePick, DivergeRecord, type DivergeFrame } from "./schemas.js";
import { divergePath } from "./paths.js";
import { divergeExclude, divergeStamp, formatDivergeFeedback, selectFrames, shouldDiverge } from "./diverge.js";
import { divergeCritic, pick, taskAgents } from "./roles.js";
import { listRetries } from "./store.js";
```

`DivergeBranch`／`DivergePick`／`DivergeRecord`／`DivergeFrame` 併進 engine 既有的 `schemas.js` import，`divergePath` 併進 `paths.js`，`listRetries` 併進 `store.js`，`divergeCritic`、`pick` 併進 `roles.js`，不要重複宣告 import。

frame 說明寫成常數：

```ts
const DIVERGE_FRAME_PROMPT: Record<DivergeFrame, string> = {
  acceptance: "假設實作方向對，但測試或斷言沒對上驗收條件。只回答要改測試的哪一點。",
  split: "假設這個任務切太大。只回答下一動應縮小到哪個可驗證的範圍，不要繼續加碼。",
  invert: "假設 .flow/feedback.md 裡的失敗才是根因。只回答下一動是什麼，不要另開新方向。",
};
```

在 `implementStage` 附近加入：

```ts
/** running 表示上次中斷（或評審額度暫停）時沒跑完，resume 要重跑，所以只有 done／skipped 的 stamp 才拿來去重；retriesSeen 任何狀態都保留 */
function readDiverge(id: string): { stamp?: string; since: number } {
  const parsed = existsSync(divergePath(id)) ? readJsonFile(divergePath(id), DivergeRecord) : undefined;
  if (!parsed?.ok) return { since: 0 };
  return { stamp: parsed.data.status === "running" ? undefined : parsed.data.stamp, since: parsed.data.retriesSeen ?? 0 };
}

function writeDiverge(id: string, record: DivergeRecord): void {
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(divergePath(id), JSON.stringify(record, null, 2));
}

async function maybeDiverge(run: FlowRun, task: TaskItem, cfg: RepoConfig): Promise<FlowRun> {
  if (run.taskPhase !== "tests" && run.taskPhase !== "code") return run;
  const phase = run.taskPhase;
  const key = `${task.id}:${phase}`;
  const attempts = run.attempts[key] ?? 0;
  const stamp = divergeStamp(task.id, phase, attempts, run.testsRedos ?? 0);
  const retries = listRetries(ownerId(run.id));
  const last = readDiverge(run.id);
  if (!shouldDiverge({
    enabled: cfg.diverge.enabled,
    after: cfg.diverge.after,
    phase, taskId: task.id, attempts: run.attempts, testsRedos: run.testsRedos,
    retries, lastStamp: last.stamp, since: last.since,
  })) return run;

  const repo = worktreeDir(run.id);
  const before = await headCommit(repo);
  const frames = selectFrames(`${run.id}:${key}:${attempts}:${run.testsRedos ?? 0}`, cfg.diverge.branches);
  const agents = taskAgents(run.cycle, taskPosition(run), cfg.tddSplit, ownerId(run.id));
  const excluded = divergeExclude({
    phase, testsRedos: run.testsRedos, lastWriter: run.lastWriter, lastTestsAuthor: run.lastTestsAuthor,
    testsAgent: agents.tests, codeAgent: agents.code,
  });
  info(run, `🔀 [${task.id}] 同一關連續失敗，先從 ${frames.length} 個角度診斷`);
  // running 時保留上一次的 retriesSeen：中斷後 resume 要用同一個 since 重算，不能被這次的筆數洗掉
  writeDiverge(run.id, { stamp, status: "running", key, frames, branches: [], retriesSeen: last.since });
  const retriesSeen = retries.length;

  // 除了鎖定的計畫檔，feedback.md 與 red-output.txt 也要還原：.flow/ 不在 git 裡，resetTo 清不掉分支對它們的改動
  const snap = snapshotPlan(run, [...LOCKED_FILES, "feedback.md", "red-output.txt"]);
  const acceptance = readJsonFile(flowFile(run, "acceptance.json"), AcceptanceList);
  const acceptanceJson = acceptance.ok ? JSON.stringify(taskAcceptance(task, acceptance.data), null, 2) : "[]";
  const taskJson = JSON.stringify(task, null, 2);
  const feedback = readFeedback(run);
  const category = retries.filter((item) => item.key === key || item.key === `${task.id}:code`).at(-1)?.category ?? "";
  const branches: DivergeBranch[] = [];
  const sweep = () => {
    rmSync(flowFile(run, "diverge-branch.json"), { force: true });
    rmSync(flowFile(run, "diverge-pick.json"), { force: true });
  };
  const revert = async () => { await resetTo(repo, before); restorePlan(run, snap); sweep(); };

  for (const frame of frames) {
    const outcome = await agentStep(
      run, pick(run.cycle, `${run.id}:${stamp}:${frame}`), `${task.id}-diverge-${frame}`,
      renderPrompt("diverge-branch", {
        frame, framePrompt: DIVERGE_FRAME_PROMPT[frame], task: taskJson, acceptance: acceptanceJson,
        feedback, category,
      }),
      { kind: "write", reset: revert },
    );
    const parsed = readJsonFile(flowFile(run, "diverge-branch.json"), DivergeBranch);
    await revert();
    if (!outcome.r.ok || !parsed.ok || parsed.data.frame !== frame) continue;
    branches.push(parsed.data);
  }

  if (branches.length < 2) {
    writeDiverge(run.id, { stamp, status: "skipped", key, frames, branches, reason: `有效分支只有 ${branches.length} 個`, retriesSeen });
    return run;
  }

  const critic = divergeCritic(run.cycle, excluded, `${run.id}:${stamp}`);
  const outcome = await agentStep(
    run, critic, `${task.id}-diverge-critic`,
    renderPrompt("diverge-critic", {
      task: taskJson, acceptance: acceptanceJson, feedback, category,
      branches: JSON.stringify(branches, null, 2),
    }),
    { kind: "review", reset: revert },
  );
  const parsed = readJsonFile(flowFile(run, "diverge-pick.json"), DivergePick);
  await revert();
  const pickOk = parsed.ok && branches.some((item) => item.frame === parsed.data.pick);
  if (!outcome.r.ok || !pickOk) {
    writeDiverge(run.id, { stamp, status: "skipped", key, frames, branches, reason: "評審輸出不合格", retriesSeen });
    return run;
  }

  writeFileSync(flowFile(run, "feedback.md"), `${feedback}${formatDivergeFeedback(parsed.data)}`);
  writeDiverge(run.id, { stamp, status: "done", key, frames, branches, pick: parsed.data, retriesSeen });
  return run;
}
```

`LOCKED_FILES`、`snapshotPlan`、`restorePlan`、`readFeedback`、`headCommit`、`resetTo` 沿用檔案既有函式。`feedback` 在快照前先讀好，結論追加在這份原文後面，所以就算分支改過 feedback.md，最後寫出的內容也是乾淨的。不要用 `discardChanges`（那是 `resetTo(HEAD)`，分支 commit 後還原不了）。

在 `implementStage` 裡，`task.kind === "confirm"` 之後、`taskPhase === "review"` 之前呼叫：

```ts
  if (run.taskPhase === "tests" || run.taskPhase === "code") {
    run = await maybeDiverge(run, task, cfg);
  }
```

注意：`implementStage` 開頭已經 `const cfg = loadRepoConfig()`。`maybeDiverge` 內部的 `agentStep` 會計入 `maxAgentRuns`；`advance()` 每一步開始才檢查次數，所以一次 `implementStage` 內的 3 到 4 次發散呼叫不會在中途被預算打斷，但會讓後續步驟更快碰到上限。這是預期行為，寫進 README。

分支人選用 `pick` 即可，不需要每家不同，也可能剛好是卡住的寫檔者；分支只產出假設，影響不大。隔離靠新 session、不傳其他分支 JSON，以及 `resetTo(before)` 加還原 `.flow/` 檔與刪 `diverge-*`。

車道（`inLane`）內的 `diverge.json` 放在該車道自己的 run 目錄，`dump` 只收所屬 run 的檔，不收車道的；要除錯時直接看車道目錄。

- [ ] **Step 6: 確認發散測試通過，且既有 engine 測試仍過**

Run: `npx vitest run src/engine.test.ts src/dump.test.ts src/diverge.test.ts`
Expected: PASS。

若 dump 的 missing 清單多了 `run/diverge.json`，把該測試改成 `expect.arrayContaining` 仍包含原本項目即可，不要要求剛好舊陣列。

- [ ] **Step 7: 跑型別與全部測試**

Run: `pnpm run typecheck && pnpm test`
Expected: 兩者皆通過。

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/dump.ts src/dump.test.ts src/engine.ts src/engine.test.ts
git commit -m "$(cat <<'EOF'
實作階段連續失敗時先發散再重試，結論寫進 feedback

EOF
)"
```

這個 commit 改變階段流程與終端機輸出（`🔀`），下一步同一個功能的 README 必須補上。若你想一個 commit 含文件，把 Task 5 併進這個 commit。

---

### Task 5: README、AGENTS.md、doctor

**Files:**
- Modify: `README.md`（設定表、行為說明）
- Modify: `AGENTS.md`（run 目錄清單、`implementStage` 一句）
- Modify: `src/cli.ts` 的 `doctor`

**Interfaces:**
- Consumes: `cfg.diverge`
- Produces: 使用者看得到關閉方式與觸發條件；`config doctor` 印出目前設定

- [ ] **Step 1: 更新 README 設定表**

在 `planReviewLayers` 那一列後面加入：

```md
| `diverge` | `{ "enabled": true, "after": 2, "branches": 3 }` | 同一任務連續因測試／實作關卡失敗時，先從 2 到 3 個角度診斷再重試；說明見表格下方 |
```

在 `planReviewLayers` 長說明後面加一段：

```md
同一個任務最近連續合格失敗剛好達到 `diverge.after` 次（分類為測試未寫、測試本身有問題、或綠燈仍未通過；不含紅燈一開始就通過）時，或 TDD 綠燈第二次失敗而退回測試時，實作階段會先跑短發散：2 到 3 個互不看見的診斷分支，再由不是卡住寫檔者的評審選一個，結論追加到 `.flow/feedback.md`。程式不依評審改流程，下一次寫測試或實作仍走原本關卡。第一次失敗不觸發，同一段連續失敗只發散一次；退回測試兩次會再發散一次。這 3 到 4 次呼叫會計入 `maxAgentRuns`，且一次 `implementStage` 內不會中途被預算打斷，緊預算時可能先碰到上限。評審額度用完而暫停時，resume 會重跑這一輪發散。可用 `"diverge": { "enabled": false }` 關閉。`config doctor` 會顯示目前的設定。adaptive 模式下這些呼叫預設用 low 強度（階段名 `diverge`）。
```

- [ ] **Step 2: 更新 AGENTS.md**

在「隔離方式」的 run 目錄清單加上 `diverge.json`（重試前短發散的結果，放在 worktree 外）。

在 `engine.ts` 那條，`implement` 括號裡補一句：任務的 `tests`／`code` 在寫檔前若連續合格失敗達 `diverge.after`、或綠燈退回測試，先跑短發散再重試。

- [ ] **Step 3: doctor 印出設定**

在 `src/cli.ts` 的 `doctor`，`planReviewLayers` 那行之後加入：

```ts
  const diverge = cfg.diverge;
  console.log(`重試前短發散：${diverge.enabled ? `同一關失敗 ${diverge.after} 次後開啟，${diverge.branches} 個分支` : "關閉"}`);
```

- [ ] **Step 4: 若有 doctor 測試就補斷言；沒有就手動跑**

Run: `pnpm dev config doctor`
Expected: 出現「重試前短發散：同一關失敗 2 次後開啟，3 個分支」（或你的設定值）。

- [ ] **Step 5: 跑全部測試**

Run: `pnpm run typecheck && pnpm test`
Expected: 兩者皆通過。

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md src/cli.ts
git commit -m "$(cat <<'EOF'
文件與 doctor 補上重試前短發散的設定與行為

EOF
)"
```

---

## 執行順序與依賴

1. Task 1 必須先做（schema 與純函式）。
2. Task 2 與 Task 3 可在 Task 1 之後並行。
3. Task 4 依賴 1、2、3。
4. Task 5 可與 Task 4 同一個 commit，或緊接其後。

## Self-Review

- **Spec coverage：** 連續合格與退回測試 → Task 1；選模與評審人選 → Task 2；frame／禁止評估 → Task 3；engine 主路徑（`redoTests` 後發散）、`resetTo(before)`、stamp 去重、`retriesSeen` 防止 code 階段重複發散、`.flow/` 檔還原、失敗不讓 run 失敗、dump → Task 4；使用者可見設定 → Task 5。`tests_not_red`、計畫階段發散、ADHD skill、adapter 關工具、依 `action` 改流程、`discardChanges`：明確不在範圍。
- **Placeholders：** 觸發函式、prompt 全文、`maybeDiverge` 與 engine 測試腳本都寫出。沒有 TBD／「類似 Task N」。
- **型別一致：** `DivergeFrame`／`DivergePick`／`DivergeRecord`／`divergeStamp`／`shouldDiverge`／`divergeExclude`／`consecutiveEligible` 在後續任務的名稱與 Task 1 相同。步驟名是 `T-1-diverge-acceptance` 與 `T-1-diverge-critic`。設定欄位是 `diverge.enabled`／`after`／`branches`。
- **已知限制：** 車道內的 `diverge.json` 不進 `dump`；一次 `implementStage` 內的發散呼叫不會在中途被 `maxAgentRuns` 打斷；評審結論只影響 feedback，省用量要靠下一次寫檔真的換方向，數字仍應對照 `costs.jsonl`。
