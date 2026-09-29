# 審查者平行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一輪的多位審查者（整份計畫審查、分層計畫審查、程式碼審查）同時執行，且任何時刻 stop 後都能 resume。

**Architecture:** 每位審查者在自己的臨時 git worktree（HEAD 加複製的 `.flow/`）內執行，結果一完成就原子存進 run 目錄。平行階段只跑 agent、不動 `run` 與交接帳本；全部結束後依 slot 順序做序列收尾（把存檔結果放回共用 `.flow/`，再走原有的驗證、交接、retry 程式）。孤兒臨時 worktree 在 `advance()` 開頭清掉。

**Tech Stack:** Node.js >=22、TypeScript、zod、vitest；git worktree。

**Spec:** `docs/superpowers/specs/2026-09-29-parallel-reviewers-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出一律用繁體中文。
- 每個 commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 使用者看得到的行為變動要更新 `README.md`；整個 branch（`feat/parallel-reviewers`）以單一 PR 合併，README 在 Task 6 一次寫完。
- 不新增 `FlowRun` 欄位；新增的資料都是 run 目錄下的檔案（舊 run 沒有這些檔案時視為沒有已完成的呼叫）。
- 路徑一律從 `paths.ts` 取得。
- 關卡判斷維持以程式能檢查的事實為準，不依賴 agent 回覆內容。
- 每個 task 結束前 `pnpm run typecheck` 與 `pnpm test` 要全過。
- 既有測試是安全網：`engine.test.ts` 的被測行為（含「程式碼審查者修改驗收條件時會被還原」）在整個改動後必須仍然通過。允許改的只有「測試怎麼觀察」：agent 副作用檔改寫到絕對路徑（臨時 worktree 會被刪）、有多位審查者又斷言先後順序的測試加 `reviewConcurrency: 1`、斷言「已還原審查者修改的檔案」訊息的改為斷言共用檔案沒被動到。不可刪除或跳過任何既有測試。

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/schemas.ts` | 修改 | `RepoConfig.reviewConcurrency` |
| `src/handoff.ts` | 修改 | `prepareHandoff`／`validateHandoffResponse` 可指定 `.flow` 目錄 |
| `src/tempWorktree.ts` | 新增 | 臨時 worktree 的建立、移除、孤兒清理；`Workspace` 型別 |
| `src/parallelReview.ts` | 新增 | `runPool`（限流、保序）；審查結果存檔（`StoredCall`、`openRound`／`saveCall`／`loadCalls`／`dropCall`） |
| `src/engine.ts` | 修改 | `agentStep` 支援 `workspace`／`tag`；`executeReviewCalls`；三個審查改成「平行執行＋序列收尾」；`advance()` 清孤兒 |
| `src/parallelEngine.test.ts` | 新增 | 用真的 git repo 與 command adapter 測平行、stop／resume、預算、隔離 |
| `README.md` | 修改 | 設定欄位與行為說明 |

---

### Task 1: `reviewConcurrency` 設定

**Files:**
- Modify: `src/schemas.ts:178`（`planReviewQuorum` 之後）
- Test: `src/schemas.test.ts`

**Interfaces:**
- Produces: `RepoConfig["reviewConcurrency"]: number | undefined`（正整數；`undefined`＝不限）

- [ ] **Step 1: 寫失敗的測試**

在 `src/schemas.test.ts` 檔尾加入（檔案已 import `RepoConfig`）：

```ts
describe("審查平行設定", () => {
  it("沒寫時為 undefined（不限）", () => {
    expect(RepoConfig.parse({}).reviewConcurrency).toBeUndefined();
  });

  it("接受正整數", () => {
    expect(RepoConfig.parse({ reviewConcurrency: 1 }).reviewConcurrency).toBe(1);
    expect(RepoConfig.parse({ reviewConcurrency: 4 }).reviewConcurrency).toBe(4);
  });

  it("拒絕 0、負數與小數", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(RepoConfig.safeParse({ reviewConcurrency: bad }).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/schemas.test.ts -t "審查平行設定"`
Expected: FAIL（`reviewConcurrency` 不存在，`safeParse` 對 0 仍成功）。

- [ ] **Step 3: 實作**

在 `src/schemas.ts` 的 `planReviewQuorum` 那行之後加入：

```ts
  /** 同一輪審查最多幾位審查者同時執行；沒寫＝不限，1＝一次一位 */
  reviewConcurrency: z.number().int().min(1).optional(),
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/schemas.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/schemas.test.ts
git commit -m "feat: 新增 reviewConcurrency 設定欄位

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 交接檔可指定 `.flow` 目錄

平行審查者的交接檔要寫在各自臨時 worktree 的 `.flow/`，所以 `prepareHandoff` 與 `validateHandoffResponse` 需要能指定目錄；不指定時行為與現在完全相同。

**Files:**
- Modify: `src/handoff.ts:9`、`src/handoff.ts:85-104`、`src/handoff.ts:106-108`
- Test: `src/handoff.test.ts`

**Interfaces:**
- Produces:
  - `prepareHandoff(id: string, _callKey: string, target: "plan" | "code", blind: boolean, flow?: string): void`
  - `validateHandoffResponse(id: string, flow?: string): JsonResult<HandoffResponse>`
  - `flow` 預設為 `flowDir(id)`

- [ ] **Step 1: 寫失敗的測試**

在 `src/handoff.test.ts` 檔尾加入（檔案已 import `existsSync, mkdirSync, readFileSync, writeFileSync`、`join`、`prepareHandoff`、`validateHandoffResponse`、`mergeHandoff`；若 `mkdtempSync`、`tmpdir` 已 import 就不重複）：

```ts
describe("指定 .flow 目錄的交接檔", () => {
  it("prepareHandoff 寫到指定目錄並只刪那裡的回覆，不動預設目錄", () => {
    const id = "f-custom-flow";
    mergeHandoff(id, source.callKey, source, { newIssues: [issue], dispositions: [] }, "writer");
    const custom = mkdtempSync(join(tmpdir(), "agentflowctl-flow-"));
    mkdirSync(flowDir(id), { recursive: true });
    writeFileSync(join(flowDir(id), "handoff-response.json"), JSON.stringify(empty));
    writeFileSync(join(custom, "handoff-response.json"), JSON.stringify(empty));

    prepareHandoff(id, "k", "code", false, custom);

    expect(readFileSync(join(custom, "handoff-context.md"), "utf8")).toContain("測試未涵蓋逾時");
    expect(existsSync(join(custom, "handoff-response.json"))).toBe(false);
    expect(existsSync(join(flowDir(id), "handoff-response.json"))).toBe(true);
    expect(existsSync(join(flowDir(id), "handoff-context.md"))).toBe(false);
  });

  it("validateHandoffResponse 讀指定目錄的回覆", () => {
    const custom = mkdtempSync(join(tmpdir(), "agentflowctl-flow-"));
    writeFileSync(join(custom, "handoff-response.json"), JSON.stringify(empty));
    expect(validateHandoffResponse("f-custom-flow-2", custom).ok).toBe(true);
    expect(validateHandoffResponse("f-custom-flow-2", join(custom, "不存在")).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/handoff.test.ts -t "指定 .flow 目錄"`
Expected: FAIL（第五個參數被忽略，context 寫進預設目錄）。

- [ ] **Step 3: 實作**

`src/handoff.ts`：

```ts
// 第 9 行改成
const responsePath = (id: string, flow = flowDir(id)) => join(flow, "handoff-response.json");
```

`prepareHandoff` 簽名與尾段改成：

```ts
export function prepareHandoff(id: string, _callKey: string, target: "plan" | "code", blind: boolean, flow = flowDir(id)): void {
  // ...（中間組出 sections 的程式不變）
  mkdirSync(flow, { recursive: true });
  writeFileSync(join(flow, "handoff-context.md"), `# 待處理交接事項\n\n${sections.length ? sections.join("\n\n") : "目前沒有待處理事項。"}\n`);
  rmSync(responsePath(id, flow), { force: true });
}
```

`validateHandoffResponse` 改成：

```ts
export function validateHandoffResponse(id: string, flow = flowDir(id)): JsonResult<HandoffResponse> {
  return readJsonFile(responsePath(id, flow), HandoffResponse);
}
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/handoff.test.ts && pnpm run typecheck`
Expected: PASS（既有的交接測試不受影響）

- [ ] **Step 5: Commit**

```bash
git add src/handoff.ts src/handoff.test.ts
git commit -m "refactor: 交接檔可指定 .flow 目錄，預設行為不變

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 臨時 worktree

**Files:**
- Create: `src/tempWorktree.ts`
- Test: `src/tempWorktree.test.ts`

**Interfaces:**
- Produces:
  - `interface Workspace { dir: string; flow: string }`（`dir`＝agent 的 cwd；`flow`＝它自己的 `.flow/`）
  - `tempWorktreesDir(runId: string): string`＝`<runDir>/tmp-review`
  - `createTempWorktree(runId: string, name: string): Promise<Workspace>`
  - `removeTempWorktree(runId: string, ws: Workspace): Promise<void>`
  - `withTempWorktree<T>(runId: string, name: string, fn: (ws: Workspace) => Promise<T>): Promise<T>`（結束或丟例外都會移除）
  - `cleanupTempWorktrees(runId: string): Promise<void>`（刪整個 `tmp-review/` 並 `git worktree prune`）
- Consumes: `git`／`removeWorktree`（`src/git.ts`）、`flowDir`／`runDir`／`worktreeDir`（`src/paths.ts`）

- [ ] **Step 1: 寫失敗的測試**

`src/tempWorktree.test.ts`：

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-temp-wt-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
execFileSync("git", ["-C", root, "add", "-A"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
process.chdir(root);

const { addWorktree } = await import("./git.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { cleanupTempWorktrees, createTempWorktree, tempWorktreesDir, withTempWorktree } = await import("./tempWorktree.js");

async function setupRun(id: string) {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "spec.md"), "# spec\n");
}

const listed = () => execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });

describe("臨時 worktree", () => {
  it("內容是 HEAD 加複製的 .flow，改動不影響 run 的 worktree，結束後被移除", async () => {
    await setupRun("t-basic");
    let dir = "";
    await withTempWorktree("t-basic", "slot-0", async (ws) => {
      dir = ws.dir;
      expect(readFileSync(join(ws.dir, "a.ts"), "utf8")).toContain("a = 1");
      expect(readFileSync(join(ws.flow, "spec.md"), "utf8")).toBe("# spec\n");
      writeFileSync(join(ws.dir, "a.ts"), "亂改");
      writeFileSync(join(ws.flow, "spec.md"), "亂改");
      expect(listed()).toContain(ws.dir);
    });
    expect(readFileSync(join(worktreeDir("t-basic"), "a.ts"), "utf8")).toContain("a = 1");
    expect(readFileSync(join(flowDir("t-basic"), "spec.md"), "utf8")).toBe("# spec\n");
    expect(existsSync(dir)).toBe(false);
    expect(listed()).not.toContain(dir);
  });

  it("fn 丟例外時也會移除", async () => {
    await setupRun("t-throw");
    let dir = "";
    await expect(withTempWorktree("t-throw", "slot-0", async (ws) => {
      dir = ws.dir;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(existsSync(dir)).toBe(false);
    expect(listed()).not.toContain(dir);
  });

  it("同時建立的多個臨時 worktree 互相獨立", async () => {
    await setupRun("t-par");
    const dirs = await Promise.all([0, 1, 2].map((n) => withTempWorktree("t-par", `slot-${n}`, async (ws) => {
      writeFileSync(join(ws.flow, "out.json"), String(n));
      await new Promise((r) => setTimeout(r, 50));
      return { dir: ws.dir, out: readFileSync(join(ws.flow, "out.json"), "utf8") };
    })));
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(3);
    expect(dirs.map((d) => d.out)).toEqual(["0", "1", "2"]);
  });

  it("cleanupTempWorktrees 清掉中斷後留下的殘骸與 git 的登記", async () => {
    await setupRun("t-orphan");
    const ws = await createTempWorktree("t-orphan", "slot-0"); // 模擬程序被中斷，沒有機會移除
    expect(listed()).toContain(ws.dir);
    await cleanupTempWorktrees("t-orphan");
    expect(existsSync(tempWorktreesDir("t-orphan"))).toBe(false);
    expect(listed()).not.toContain(ws.dir);
  });

  it("沒有殘骸、甚至沒有 run worktree 時 cleanupTempWorktrees 不出錯", async () => {
    await expect(cleanupTempWorktrees("t-none")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/tempWorktree.test.ts`
Expected: FAIL（找不到 `./tempWorktree.js`）

- [ ] **Step 3: 實作**

`src/tempWorktree.ts`：

```ts
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, removeWorktree } from "./git.js";
import { flowDir, runDir, worktreeDir } from "./paths.js";

/** agent 的工作環境：dir 是 cwd，flow 是它自己的 .flow/ */
export interface Workspace {
  dir: string;
  flow: string;
}

/** 平行審查用的臨時 worktree 都放這裡；孤兒在 advance() 開頭統一清掉 */
export const tempWorktreesDir = (runId: string) => join(runDir(runId), "tmp-review");

/** 建立臨時 worktree：detached、內容是 run worktree 的 HEAD，並複製目前的 .flow/（.flow/ 不受 git 管理，要另外帶） */
export async function createTempWorktree(runId: string, name: string): Promise<Workspace> {
  const dir = join(tempWorktreesDir(runId), name);
  mkdirSync(tempWorktreesDir(runId), { recursive: true });
  await git(worktreeDir(runId), "worktree", "add", "--detach", dir, "HEAD");
  const flow = join(dir, ".flow");
  if (existsSync(flowDir(runId))) cpSync(flowDir(runId), flow, { recursive: true });
  else mkdirSync(flow, { recursive: true });
  return { dir, flow };
}

export async function removeTempWorktree(runId: string, ws: Workspace): Promise<void> {
  try {
    await removeWorktree(worktreeDir(runId), ws.dir);
  } catch {
    // 目錄可能已經不在，登記交給下面的 rmSync 與 cleanupTempWorktrees 的 prune
  }
  rmSync(ws.dir, { recursive: true, force: true });
}

export async function withTempWorktree<T>(runId: string, name: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = await createTempWorktree(runId, name);
  try {
    return await fn(ws);
  } finally {
    await removeTempWorktree(runId, ws);
  }
}

/** 刪掉整個臨時目錄並讓 git 忘掉它們；Ctrl-C（process.exit 不跑 finally）、SIGTERM、當機後都靠這個收拾 */
export async function cleanupTempWorktrees(runId: string): Promise<void> {
  rmSync(tempWorktreesDir(runId), { recursive: true, force: true });
  if (existsSync(worktreeDir(runId))) await git(worktreeDir(runId), "worktree", "prune");
}
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/tempWorktree.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tempWorktree.ts src/tempWorktree.test.ts
git commit -m "feat: 新增臨時 worktree 與孤兒清理

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 限流執行與審查結果存檔

**Files:**
- Create: `src/parallelReview.ts`
- Test: `src/parallelReview.test.ts`

**Interfaces:**
- Produces:
  - `runPool<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]>`：同時最多 `limit` 個，結果依輸入順序；`fn` 丟例外時其餘照常跑完，最後才把第一個例外丟出
  - `StoredCall`（zod schema 與型別）：`{ key, reviewer, agent, step, callKey, summary, output: string | null, handoffResponse: string | null }`
  - `openRound(runId: string, scope: string, fingerprint: string): string`：回傳這一輪的存檔目錄，並刪掉同 scope 下其他指紋的目錄
  - `saveCall(dir: string, call: StoredCall): void`（原子寫入）
  - `loadCalls(dir: string): Map<string, StoredCall>`（依 `key`；損毀的檔案刪掉並略過）
  - `dropCall(dir: string, key: string): void`
- Consumes: `runDir`（`src/paths.ts`）

- [ ] **Step 1: 寫失敗的測試**

`src/parallelReview.test.ts`：

```ts
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/parallelReview.test.ts`
Expected: FAIL（找不到 `./parallelReview.js`）

- [ ] **Step 3: 實作**

`src/parallelReview.ts`：

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runDir } from "./paths.js";

/**
 * 依序啟動、同時最多 limit 個；結果依輸入順序回傳。
 * fn 丟例外時，其餘已啟動與待啟動的項目仍會跑完（讓它們的收尾，例如移除臨時 worktree，都能完成），最後才把第一個例外丟出。
 */
export async function runPool<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * 一次已執行成功、尚未套用的審查呼叫。放在 run 目錄（worktree 外），中斷後 resume 直接沿用。
 * 只存原始檔案內容：套用時再放回共用的 .flow/，走原有的驗證與交接程式。
 */
export const StoredCall = z.object({
  /** 同一輪內唯一的呼叫識別 */
  key: z.string(),
  reviewer: z.string(),
  agent: z.string(),
  step: z.string(),
  callKey: z.string(),
  summary: z.string(),
  /** 裁決檔原文；agent 沒寫時為 null */
  output: z.string().nullable(),
  /** handoff-response.json 原文；agent 沒寫時為 null */
  handoffResponse: z.string().nullable(),
});
export type StoredCall = z.infer<typeof StoredCall>;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const scopeDir = (runId: string, scope: string) => join(runDir(runId), "parallel-review", scope);

/** 這一輪的存檔目錄；同 scope 下其他指紋（計畫或程式碼已變、輪次已換）的結果一律作廢 */
export function openRound(runId: string, scope: string, fingerprint: string): string {
  const base = scopeDir(runId, scope);
  const mine = hash(fingerprint);
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      if (name !== mine) rmSync(join(base, name), { recursive: true, force: true });
    }
  }
  const dir = join(base, mine);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const callFile = (dir: string, key: string) => join(dir, `${hash(key)}.json`);

export function saveCall(dir: string, call: StoredCall): void {
  const path = callFile(dir, call.key);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(call));
  renameSync(tmp, path);
}

export function loadCalls(dir: string): Map<string, StoredCall> {
  const calls = new Map<string, StoredCall>();
  if (!existsSync(dir)) return calls;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!name.endsWith(".json")) {
      rmSync(path, { force: true }); // 寫到一半留下的 .tmp
      continue;
    }
    try {
      const call = StoredCall.parse(JSON.parse(readFileSync(path, "utf8")));
      calls.set(call.key, call);
    } catch {
      rmSync(path, { force: true }); // 損毀或格式不符：當作沒有，重跑
    }
  }
  return calls;
}

export function dropCall(dir: string, key: string): void {
  rmSync(callFile(dir, key), { force: true });
}
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/parallelReview.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parallelReview.ts src/parallelReview.test.ts
git commit -m "feat: 新增限流執行器與審查結果存檔

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `agentStep` 支援臨時 workspace、`advance()` 清孤兒

這一步不改任何審查流程的行為；只讓 `agentStep` 有能力在指定 workspace 執行，並在 `advance()` 開頭清孤兒。

**Files:**
- Modify: `src/engine.ts`（`target()` 約第 60 行、`StepMode` 約第 86 行、`agentStep` 約第 110-153 行、`advance()` 約第 1185 行、import 區）
- Test: `src/parallelEngine.test.ts`（新增，先只放孤兒清理的測試）

**Interfaces:**
- Consumes: `Workspace`、`cleanupTempWorktrees`（Task 3）；`prepareHandoff(..., flow)`（Task 2）
- Produces:
  - `StepMode` 新增 `workspace?: Workspace`（agent 在這個目錄執行、交接檔寫它的 `.flow/`；`reset` 預設為空操作）與 `tag?: string`（終端機訊息前綴 `[tag] `）
  - `advance()` 開頭（`recoverHandoff` 之後）呼叫 `cleanupTempWorktrees(run.id)`

- [ ] **Step 1: 寫失敗的測試**

新增 `src/parallelEngine.test.ts`，先放共用的 repo 設定與孤兒清理測試（後面的 task 會往這個檔案加測試）：

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-parallel-engine-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "base.txt"), "base\n");
execFileSync("git", ["-C", root, "add", "base.txt"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

const { addWorktree, commitAll } = await import("./git.js");
const { advance, resetQuotaState } = await import("./engine.js");
const { mergeHandoff } = await import("./handoff.js");
const { flowDir, logDir, runDir, worktreeDir } = await import("./paths.js");
const { createTempWorktree, tempWorktreesDir } = await import("./tempWorktree.js");

beforeEach(() => resetQuotaState());

const listed = () => execFileSync("git", ["-C", root, "worktree", "list", "--porcelain"], { encoding: "utf8" });

describe("孤兒臨時 worktree", () => {
  it("advance 開頭清掉上次中斷留下的臨時 worktree", async () => {
    const id = "pe-orphan";
    await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
    mkdirSync(flowDir(id), { recursive: true });
    const ws = await createTempWorktree(id, "slot-0"); // 模擬 Ctrl-C 時沒有機會移除
    expect(listed()).toContain(ws.dir);
    const now = new Date().toISOString();
    await advance({
      id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "done",
      autopilot: true, maxAgentRuns: 10, cycle: ["a", "b"], attempts: {},
      taskIndex: 0, taskPhase: "tests", createdAt: now, updatedAt: now,
    });
    expect(existsSync(tempWorktreesDir(id))).toBe(false);
    expect(listed()).not.toContain(ws.dir);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/parallelEngine.test.ts`
Expected: FAIL（殘骸仍在，`tempWorktreesDir(id)` 還存在）。

- [ ] **Step 3: 實作**

`src/engine.ts` import 區加入：

```ts
import { cleanupTempWorktrees, withTempWorktree, type Workspace } from "./tempWorktree.js";
```

（`withTempWorktree` 在 Task 6 才用到；若 typecheck 因未使用而報錯，這一步只 import `cleanupTempWorktrees` 與 `Workspace`，Task 6 再補。）

`target()` 加可選的 cwd：

```ts
function target(run: FlowRun, step: string, agent: string, cwd = worktreeDir(run.id)): AgentTarget {
  return { runId: run.id, cwd, logFile: nextLogFile(logDir(run.id), run.stage, step, agent), stage: run.stage, step };
}
```

`StepMode` 加兩個欄位：

```ts
  /** 在這個臨時 workspace 執行：agent 的 cwd 與交接檔都用它，不碰共用的 worktree；審查類額度用完不會在這裡重試，reset 是空操作 */
  workspace?: Workspace;
  /** 平行時加在終端機訊息前面，分辨是哪位審查者 */
  tag?: string;
```

`agentStep` 內：

```ts
  const cfg = loadRepoConfig();
  const say = (msg: string) => info(run, mode.tag ? `[${mode.tag}] ${msg}` : msg);
  const reset = mode.reset ?? (mode.workspace ? () => {} : () => discardChanges(worktreeDir(run.id)));
```

並把迴圈內四處 `info(run, …)`（`🔁` 代打、`🤖` 選模、`↳ CLI 回報實際模型`、`⛽`）改成 `say(…)`；`prepareHandoff` 與 `target` 那兩行改成：

```ts
    prepareHandoff(run.id, callKey, handoffTarget(run), mode.blind ?? false, mode.workspace?.flow);
    const r = await runAgent(agent, { ...resolveAgent(cfg, agent), model: selected.name },
      { ...target(run, step, agent, mode.workspace?.dir), strength: selected.strength, targetStrength: selected.targetStrength }, prompt);
```

`advance()` 在 `recoverHandoff(run.id);` 之後加：

```ts
  await cleanupTempWorktrees(run.id); // 上次被中斷（Ctrl-C、SIGTERM、當機）時留下的平行審查臨時 worktree
```

- [ ] **Step 4: 執行確認通過**

Run: `pnpm run typecheck && npx vitest run src/parallelEngine.test.ts src/engine.test.ts`
Expected: PASS（既有 engine 測試全過，因為沒有人傳 `workspace`）

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/parallelEngine.test.ts
git commit -m "feat: agentStep 支援臨時 workspace，advance 開頭清孤兒臨時 worktree

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 整份計畫審查改為平行

引入 `executeReviewCalls`（平行階段）與 `applyPlanReview`（序列收尾），先套用在 `planReviewFull`。README 也在這一步一次寫完。

**Files:**
- Modify: `src/engine.ts`（新增 `executeReviewCalls`、`replay`；`PlanReviewCallSpec` 加 `key`；`collectPlanReview` 改為 `applyPlanReview`；`planReviewFull` 改寫）
- Modify: `README.md`（設定表 `planReviewQuorum` 那列之後、分層審查段落之後）
- Test: `src/parallelEngine.test.ts`

**Interfaces:**
- Consumes: `runPool`、`openRound`、`saveCall`、`loadCalls`、`dropCall`、`StoredCall`（Task 4）；`withTempWorktree`（Task 3）；`agentStep` 的 `workspace`／`tag`（Task 5）
- Produces（engine.ts 內部，Task 7、8 沿用）:
  - `interface ReviewCall { key: string; slot: number; reviewer: string; step: string; prompt: string; output: string; modelScope?: string }`
  - `interface Finished { stored: StoredCall; ok: boolean }`（`ok=false`＝agent 執行失敗，未存檔）
  - `executeReviewCalls(run: FlowRun, cfg: RepoConfig, scope: string, fingerprint: string, calls: ReviewCall[]): Promise<{ dir: string; finished: Finished[] } | undefined>`：`undefined`＝預算不足，呼叫端應原樣回傳 `run`；有呼叫額度用完時丟 `QuotaPause`
  - `replay(run: FlowRun, stored: StoredCall, output: string): void`：把存檔內容寫回共用 `.flow/`
  - `storedOutcome(stored: StoredCall, ok: boolean): StepOutcome`
  - `applyPlanReview(run: FlowRun, spec: PlanReviewCallSpec, done: Finished, dir: string): { run: FlowRun; collected?: Collected }`（同步）

- [ ] **Step 1: 寫失敗的測試**

在 `src/parallelEngine.test.ts` 加入共用 helper 與第一組測試。helper 放在 `beforeEach` 之後：

```ts
/** 審查者腳本：記錄自己在哪個 slot 啟動與結束，可睡一下、可模擬額度用完、可亂改檔案 */
function writeReviewer(name: string): string {
  const file = join(root, name);
  writeFileSync(file, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const ROOT = ${JSON.stringify(root)};
const slot = basename(process.cwd());
const mode = readFileSync(".flow/review-mode.txt", "utf8").trim();
appendFileSync(ROOT + "/events.log", "start " + slot + "\\n");
if (existsSync(ROOT + "/quota-" + slot)) { console.error("usage limit reached"); process.exit(1); }
if (existsSync(ROOT + "/sleep")) await new Promise((r) => setTimeout(r, Number(readFileSync(ROOT + "/sleep", "utf8"))));
if (existsSync(ROOT + "/tamper")) { writeFileSync("feature.ts", "亂改"); writeFileSync(".flow/acceptance.json", "[]"); }
const context = readFileSync(".flow/handoff-context.md", "utf8");
const id = context.match(/## ([a-f0-9]+)：/)?.[1];
writeFileSync(mode.startsWith("plan-") ? ".flow/plan-review.json" : ".flow/review.json", JSON.stringify({ verdict: "approve", items: [] }));
writeFileSync(".flow/handoff-response.json", JSON.stringify({
  newIssues: [],
  dispositions: mode.endsWith("close") && id ? [{ id, status: "resolved", reason: "已核對", evidence: "src/api.test.ts:25" }] : [],
}));
appendFileSync(ROOT + "/events.log", "end " + slot + "\\n");
`);
  return file;
}

const events = () => (existsSync(join(root, "events.log")) ? readFileSync(join(root, "events.log"), "utf8").trim().split("\n") : []);
const resetEvents = () => writeFileSync(join(root, "events.log"), "");
const setFlag = (name: string, value = "") => writeFileSync(join(root, name), value);
const clearFlag = (name: string) => rmSync(join(root, name), { force: true });

const baseRun = (id: string, stage: "plan_review" | "review", extra: Record<string, unknown> = {}) => {
  const now = new Date().toISOString();
  return {
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "測試功能", stage,
    autopilot: true, maxAgentRuns: 10, cycle: ["a", "b", "c"], attempts: {},
    // 計畫審查通過後會接著進 implement；測試只關心審查，所以停在計畫階段結束的邊界
    ...(stage === "plan_review" ? { stopAfter: "plan" as const } : {}),
    taskIndex: 0, taskPhase: "tests" as const, createdAt: now, updatedAt: now, ...extra,
  };
};

function configure(script: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(root, "flow.config.json"), JSON.stringify({
    agents: Object.fromEntries(["a", "b", "c"].map((n) => [n, { adapter: "command", command: ["node", script] }])),
    cycle: ["a", "b", "c"], ...extra,
  }));
}

/** 計畫審查用的 run：計畫作者 a，審查者從 b、c 選；沒有 tasks.json，走整份審查 */
async function planReviewSetup(id: string, mode: "plan-close" | "plan-open" = "plan-close") {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "review-mode.txt"), mode);
  const tasks = [{ id: "T-1", title: "任務 T-1", description: "改 src/a.ts", dependsOn: [] as string[], acceptance: ["AC-1"], complexity: "low" }];
  writeFileSync(join(flowDir(id), "spec.md"), "# 規格\n");
  writeFileSync(join(flowDir(id), "plan.md"), "# 計畫\n整體做法\n\n## T-1 難度\n低\n");
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "匯出 answer" }]));
  writeFileSync(join(flowDir(id), "tasks.json"), JSON.stringify(tasks));
  writeFileSync(join(flowDir(id), "tasks.ordered.json"), JSON.stringify(tasks));
  const source = { stage: "spec" as const, step: "spec", agent: "a", callKey: `${id}:spec` };
  mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "計畫待核對", evidence: "spec.md:2", targetStage: "plan" }], dispositions: [] }, "writer");
}
```

測試：

```ts
describe("整份計畫審查平行", () => {
  it("兩位審查者同時執行，log 序號不撞號", async () => {
    const id = "pe-plan-par";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("sleep", "300");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("sleep");
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("implement"); // 計畫審查全數核准，停在計畫階段的邊界
    // 兩個都開始之後才有人結束
    expect(events().slice(0, 2).every((line) => line.startsWith("start"))).toBe(true);
    expect(events().slice(2).every((line) => line.startsWith("end"))).toBe(true);
    const seqs = readdirSync(logDir(id)).map((f) => f.split("-")[0]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("reviewConcurrency 為 1 時一次一位", async () => {
    const id = "pe-plan-seq";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2, reviewConcurrency: 1 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("sleep", "100");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("sleep");
    expect(run.stage).toBe("paused");
    expect(run.pausedStage).toBe("implement");
    expect(events().map((line) => line.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  });

  it("審查者亂改程式碼與 .flow 不會動到共用的 worktree", async () => {
    const id = "pe-plan-tamper";
    configure(writeReviewer("reviewer.mjs"));
    await planReviewSetup(id);
    setFlag("tamper");
    const before = readFileSync(join(flowDir(id), "acceptance.json"), "utf8");
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", stopAfter: "plan" }));
    clearFlag("tamper");
    expect(run.stage).toBe("paused");
    expect(readFileSync(join(flowDir(id), "acceptance.json"), "utf8")).toBe(before);
    expect(existsSync(join(worktreeDir(id), "feature.ts"))).toBe(false);
    expect(execFileSync("git", ["-C", worktreeDir(id), "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("額度用完：其他審查者跑完並存檔後暫停；resume 只補跑沒完成的", async () => {
    const id = "pe-plan-quota";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("plan_review");
    expect(events().filter((line) => line === "end slot-0")).toHaveLength(1); // slot-0 完整跑完
    clearFlag("quota-slot-1");

    resetQuotaState(); // 模擬 resume 時是新的程序
    resetEvents();
    const resumed = await advance({ ...paused, stage: "plan_review", pausedStage: undefined, pauseReason: undefined });
    expect(resumed.stage).toBe("paused");
    expect(resumed.pausedStage).toBe("implement");
    expect(events()).not.toContain("start slot-0"); // 沿用已存檔的結果，沒有重跑
    expect(events()).toContain("start slot-1");
  });

  it("已存檔的結果損毀時當作沒有並重跑", async () => {
    const id = "pe-plan-corrupt";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "plan_review", { planWriter: "a" }));
    clearFlag("quota-slot-1");
    const dir = join(runDir(id), "parallel-review", "plan-review");
    const round = join(dir, readdirSync(dir)[0]!);
    for (const f of readdirSync(round)) writeFileSync(join(round, f), "{ 壞掉");

    resetQuotaState();
    resetEvents();
    const resumed = await advance({ ...paused, stage: "plan_review", pausedStage: undefined, pauseReason: undefined });
    expect(resumed.stage).toBe("paused");
    expect(resumed.pausedStage).toBe("implement");
    expect(events()).toContain("start slot-0"); // 損毀的被丟掉，重跑
  });

  it("預算不足時只啟動預算內的呼叫，run 以 agent_budget 失敗", async () => {
    const id = "pe-plan-budget";
    configure(writeReviewer("reviewer.mjs"), { planReviewQuorum: 2 });
    await planReviewSetup(id);
    resetEvents();
    const run = await advance(baseRun(id, "plan_review", { planWriter: "a", maxAgentRuns: 1 }));
    expect(run.stage).toBe("failed");
    expect(run.failureCategory).toBe("agent_budget");
    expect(events().filter((line) => line.startsWith("start"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/parallelEngine.test.ts`
Expected: FAIL（現在是序列：第一個測試的事件順序會是 `start,end,start,end`；額度測試 resume 會重跑 slot-0；預算測試會多啟動）。

- [ ] **Step 3: 實作**

`src/engine.ts` 補 import：

```ts
import { dropCall, loadCalls, openRound, runPool, saveCall, type StoredCall } from "./parallelReview.js";
```

在 `collectPlanReview` 之前加入平行階段的共用程式：

```ts
// ───────────────────────── 平行審查 ─────────────────────────

/** 平行階段的一次審查呼叫 */
interface ReviewCall {
  /** 同一輪內唯一；存檔與沿用都靠它 */
  key: string;
  slot: number;
  reviewer: string;
  step: string;
  prompt: string;
  /** agent 寫在 .flow/ 的裁決檔名 */
  output: string;
  modelScope?: string;
}

/** ok＝false 代表 agent 執行失敗（不存檔，交給序列收尾走原有的 retry） */
interface Finished { stored: StoredCall; ok: boolean }

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const handoffResponseFile = (run: FlowRun) => join(flowDir(run.id), "handoff-response.json");

/**
 * 平行階段：每位審查者在自己的臨時 worktree 執行，成功的結果立刻存檔。
 * 這個階段不改 run、不寫交接帳本、不呼叫 retry。
 * - 已有同一輪存檔的呼叫直接沿用（resume）
 * - 預算（maxAgentRuns）不夠時只啟動預算內的，回傳 undefined，呼叫端應原樣回傳 run，由 advance 判定 agent_budget
 * - 有呼叫額度用完時，其他呼叫照常跑完並存檔，最後才丟 QuotaPause
 */
async function executeReviewCalls(
  run: FlowRun, cfg: RepoConfig, scope: string, fingerprint: string, calls: ReviewCall[],
): Promise<{ dir: string; finished: Finished[] } | undefined> {
  if (calls.length === 0) return { dir: "", finished: [] };
  const dir = openRound(run.id, scope, fingerprint);
  const saved = loadCalls(dir);
  let budget = run.maxAgentRuns - agentRuns(run.id);
  // 已有存檔的不花預算；其餘依序佔預算，超出的這次不啟動
  const launch = calls.filter((call) => saved.has(call.key) || budget-- > 0);
  const limit = cfg.reviewConcurrency ?? Infinity;
  const tagged = limit > 1 && launch.filter((call) => !saved.has(call.key)).length > 1;
  // 預算內能跑的照跑並存檔，之後 resume 加大預算就不必重付
  const executed = await runPool(launch, limit, (call) => executeOne(run, dir, saved, call, tagged));
  const quota = executed.find((item): item is { quota: string } => "quota" in item);
  if (quota) throw new QuotaPause(quota.quota);
  if (launch.length < calls.length) return undefined;
  return { dir, finished: executed as Finished[] };
}

async function executeOne(
  run: FlowRun, dir: string, saved: Map<string, StoredCall>, call: ReviewCall, tagged: boolean,
): Promise<Finished | { quota: string }> {
  const reused = saved.get(call.key);
  if (reused) {
    info(run, `   ↪ 沿用本輪已完成的審查（${call.reviewer}）`);
    return { stored: reused, ok: true };
  }
  try {
    return await withTempWorktree(run.id, `slot-${call.slot}`, async (ws) => {
      rmSync(join(ws.flow, call.output), { force: true });
      const outcome = await agentStep(run, call.reviewer, call.step, call.prompt, {
        kind: "review", slot: call.slot, modelScope: call.modelScope, workspace: ws, tag: tagged ? call.reviewer : undefined,
      });
      const stored: StoredCall = {
        key: call.key, reviewer: call.reviewer, agent: outcome.agent, step: outcome.step, callKey: outcome.callKey,
        summary: outcome.r.summary,
        output: readIfExists(join(ws.flow, call.output)),
        handoffResponse: readIfExists(join(ws.flow, "handoff-response.json")),
      };
      if (outcome.r.ok) saveCall(dir, stored); // 先存檔，臨時 worktree 才會被移除
      return { stored, ok: outcome.r.ok };
    });
  } catch (err) {
    if (err instanceof QuotaPause) return { quota: err.message };
    throw err;
  }
}

/** 序列收尾第一步：把存檔的內容放回共用 .flow/，之後就能沿用原有的驗證與交接程式 */
function replay(run: FlowRun, stored: StoredCall, output: string): void {
  mkdirSync(flowDir(run.id), { recursive: true });
  const put = (path: string, text: string | null) => (text === null ? rmSync(path, { force: true }) : writeFileSync(path, text));
  put(flowFile(run, output), stored.output);
  put(handoffResponseFile(run), stored.handoffResponse);
}

/** 存檔內容還原成 finishHandoff 需要的 StepOutcome */
function storedOutcome(stored: StoredCall, ok: boolean): StepOutcome {
  return {
    r: { ok, quotaExhausted: false, summary: stored.summary, usageReported: false },
    agent: stored.agent, step: stored.step, callKey: stored.callKey,
  };
}
```

`PlanReviewCallSpec` 加欄位 `key: string;`（註解：`/** 這一輪內唯一的呼叫識別，存檔與沿用用 */`）。

把 `collectPlanReview` 整個換成 `applyPlanReview`（同步；沒有 `await`，不再需要 `snapshotPlan`／`restorePlan`）：

```ts
/**
 * 整份審查與分層審查共用的序列收尾：驗證裁決與交接。
 * 失敗時回傳已呼叫 retry 的 run、沒有 collected，呼叫端應直接回傳這個 run；
 * 不合格的存檔結果一併刪掉，否則同一輪重跑會反覆讀到同一份。
 */
function applyPlanReview(run: FlowRun, spec: PlanReviewCallSpec, done: Finished, dir: string): { run: FlowRun; collected?: Collected } {
  const { reviewer, step } = spec;
  const stop = (category: RetryCategory, reason: string) => {
    dropCall(dir, spec.key);
    return { run: retry(recordModelReviewFailure(run, step, reviewer, spec.scope), "plan-review-run", reason, "plan_review", category) };
  };
  if (!done.ok) return stop("agent_error", `Agent 執行失敗：${done.stored.summary}`);
  replay(run, done.stored, spec.output);
  const review = readJsonFile(flowFile(run, spec.output), ConsistentReviewResult);
  if (!review.ok) return stop("format_invalid", review.error);
  // 群審查不帶關卡：索引要求修改並新增事項後，群的核准不算矛盾；最後由 planSettled 檢查未結事項
  const handoffError = finishHandoff(run, storedOutcome(done.stored, true), "reviewer", spec.gated ? { target: "plan", verdict: review.data.verdict } : undefined);
  if (handoffError) return stop("handoff_invalid", handoffError);
  run = clearModelReviewFailure(run, step, reviewer, spec.scope);
  // 審查紀錄移到 worktree 外面：之後的仲裁者看不到是哪一家提的意見
  mkdirSync(join(runDir(run.id), "reviews"), { recursive: true });
  writeFileSync(join(runDir(run.id), "reviews", spec.archive), readFileSync(flowFile(run, spec.output)));
  rmSync(flowFile(run, spec.output), { force: true });
  if (review.data.verdict === "approve") {
    info(run, `   ✓ ${reviewer} 核准${spec.subject}`);
    return { run, collected: { reviewer, verdict: "approve", issueLines: [] } };
  }
  info(run, `   ✗ ${reviewer} 要求修改${spec.subject}`);
  const issueLines = review.data.items
    .filter((i) => i.status !== "met")
    .map((i) => reviewIssue(i.criterion, i.status, i.note));
  return { run, collected: { reviewer, verdict: "changes_requested", issueLines } };
}
```

`planReviewFull` 改寫：

```ts
async function planReviewFull(run: FlowRun, cfg: RepoConfig): Promise<FlowRun> {
  // 整份審查不維護分層狀態；之後若又切回分層，不能沿用這之前的 approve
  rmSync(planReviewStatePath(run.id), { force: true });
  const author = run.planWriter ?? planAgent(run.cycle, run.id);
  const round = (run.attempts["plan-review"] ?? 0) + 1;
  const panel = reviewers(run.cycle, author, cfg.planReviewQuorum, `${run.id}:plan-review:${round}`);

  const specs: PlanReviewCallSpec[] = panel.map((reviewer, slot) => ({
    key: `full:${reviewer}`, reviewer, step: "plan-review", slot, gated: true, subject: "計畫",
    prompt: renderPrompt("plan-review", { reviewer, author, requirement: run.requirement }),
    output: "plan-review.json", archive: `plan-review-${round}-${reviewer}.json`,
  }));
  for (const spec of specs) info(run, `🧐 計畫審查第 ${round} 輪（${spec.reviewer}，作者 ${author}）`);
  const ran = await executeReviewCalls(run, cfg, "plan-review", `${round}:${currentPlanKey(run)}`, specs);
  if (!ran) return run;

  const calls: Collected[] = [];
  for (const [i, spec] of specs.entries()) {
    const passed = applyPlanReview(run, spec, ran.finished[i]!, ran.dir);
    run = passed.run;
    if (!passed.collected) return run;
    calls.push(passed.collected);
  }
  return concludePlanReview(run, cfg, round, calls);
}
```

`planReviewLayered` 這一步暫時編不過（它還在呼叫 `collectPlanReview`）。為了讓這個 commit 可編譯，先在 `planReviewLayered` 的 `runCall` 內把

```ts
    const passed = await collectPlanReview(run, { ...spec, slot });
```

暫時改成：

```ts
    const call = { ...spec, slot, key };
    const ran = await executeReviewCalls(run, cfg, "plan-review", `${round}:${planKey}`, [call]);
    if (!ran) return false;
    const passed = applyPlanReview(run, call, ran.finished[0]!, ran.dir);
```

（這是過渡寫法，Task 7 會整段改成平行；此時分層審查仍是一個一個跑，行為與之前相同。`return false` 對應「預算不足，run 原樣」——`runCall` 的呼叫端會 `return run`。）

- [ ] **Step 4: 執行確認通過**

Run: `pnpm run typecheck && npx vitest run src/parallelEngine.test.ts src/engine.test.ts src/planReview.test.ts`

Expected: `parallelEngine.test.ts` 全部 PASS。`engine.test.ts` 有一批既有測試會因為「agent 的副作用檔現在寫在臨時 worktree、事後被刪」或「多位審查者的先後順序不固定」而失敗，這是預期的，逐一遷移（不改被測行為，只改測試怎麼觀察）：

1. **`layeredRun` 一族（分層計畫審查）**：照 Task 7 Step 1 的「先遷移 `layeredRun`」四點做（`concurrency` 選項預設 1、`seen-prompts.txt` 改寫絕對路徑、`seen`／`resetSeen`、`index-prompt.txt`）。這一步只做遷移，新測試留到 Task 7。
2. **其他測試**：凡是斷言審查腳本寫在共用 `.flow/` 的檔案（例如自訂腳本寫了 `.flow/xxx.txt` 之後由測試讀取），改成腳本寫到 `join(root, …)` 的絕對路徑。凡是有多位審查者又斷言呼叫先後順序的，在該測試的 config 加 `reviewConcurrency: 1`。
3. **斷言「已還原審查者修改的檔案」訊息的測試**（若有）：改成斷言共用的 `.flow/` 檔案內容與程式碼沒被動到。

驗證遷移沒有掩蓋問題：遷移後 `npx vitest run src/engine.test.ts` 必須全過，而且沒有任何測試被刪除或跳過（`git diff --stat src/engine.test.ts` 只有斷言觀察方式的變動）。`snapshotPlan`／`restorePlan`／`PLAN_REPLY_FILES`／`discardChanges` 等在 engine.ts 內若已不再使用而讓 typecheck 報 unused，刪掉不再使用的區域定義與 import；仍被其他階段使用的不要動。

- [ ] **Step 5: 更新 README**

在 `README.md` 設定表 `planReviewQuorum` 那列（約第 200 行）之後加：

```
| `reviewConcurrency` | 不限 | 同一輪審查最多幾位審查者同時執行；`1` 為一次一位 |
```

在分層審查那段（約第 211 行）之後加一段：

```
同一輪的審查者（整份計畫審查、分層計畫審查的索引與各群、程式碼審查）預設同時執行，可用 `reviewConcurrency` 限制同時數量。每位審查者在自己的臨時 git worktree 裡工作（程式碼是目前的 HEAD、`.flow/` 是複製的），所以審查者改了什麼都不會影響 run 的 worktree 或其他審查者；審查結果一完成就存進 `.agentflowctl/runs/<id>/parallel-review/`。任何時候 Ctrl-C 或被中斷，之後 `resume` 只會補跑沒完成的審查者，已完成的不重跑；中斷留下的臨時 worktree 在下次執行時自動清掉。若有審查者的額度用完，其他審查者仍會跑完並存檔，全部結束後才暫停，`resume` 時只補跑額度用完的那位。同時執行時，終端機訊息會加上 `[審查者]` 前綴。
```

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/parallelEngine.test.ts README.md
git commit -m "feat: 整份計畫審查的審查者平行執行，完成即存檔可重播

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 分層計畫審查改為平行

索引審查與各群審查所有呼叫一起平行；「已套用」的進度檔（`plan-review-state.json`）維持現有語意。

**Files:**
- Modify: `src/engine.ts:planReviewLayered`
- Test: `src/parallelEngine.test.ts`（另外靠既有的「分層計畫審查」測試驗證行為不變）

**Interfaces:**
- Consumes: Task 6 的 `executeReviewCalls`、`applyPlanReview`、`PlanReviewCallSpec.key`

- [ ] **Step 1: 寫失敗的測試**

分層測試的 helper（`layeredRun`、`planReviewRun`、`APPROVE`、`seen`、`reviewState`）都在 `src/engine.test.ts`（約第 706-775 行），新測試直接加在該檔案的 `describe("分層計畫審查", …)` 內，共用這些 helper。

**先遷移 `layeredRun`**（若 Task 6 Step 4 已做過，這一段跳過，直接加下面兩個新測試）。原因有兩個：審查腳本寫在 `.flow/` 的副作用檔（`seen-prompts.txt`、`index-prompt.txt`）現在寫進臨時 worktree、隨之被刪除；而且平行後各呼叫的先後順序不固定，`seen(id) === "index\ngroup\ngroup\n"` 這類斷言會不穩。改法：

1. `layeredRun` 的 `opts` 加 `concurrency?: number`，config 加上 `reviewConcurrency: opts.concurrency ?? 1`（既有測試維持一次一位，順序固定；新測試才傳大一點的數字）。
2. 腳本改成把「看過的 prompt 種類」寫到絕對路徑。在 `layeredRun` 產生腳本的模板字串裡，把

   ```js
   appendFileSync(".flow/seen-prompts.txt", kind + "\\n");
   ```

   換成

   ```js
   appendFileSync(${JSON.stringify(join(root, `${id}-seen-prompts.txt`))}, kind + "\\n");
   ```

3. `seen`／`resetSeen` 改讀寫同一個絕對路徑：

   ```ts
   const seenFile = (id: string) => join(root, `${id}-seen-prompts.txt`);
   const seen = (id: string) => readFileSync(seenFile(id), "utf8");
   const resetSeen = (id: string) => writeFileSync(seenFile(id), "");
   ```

4. 「索引 prompt 帶全部任務描述…」那個測試，腳本裡的 `writeFileSync(".flow/index-prompt.txt", prompt)` 改成寫到 `join(root, "f-plan-layers-index-prompt.txt")` 的絕對路徑（在測試字串裡用 `${JSON.stringify(...)}`），讀取端跟著改。

然後加兩個新測試：

```ts
  it("索引與各群審查同時執行", async () => {
    const id = "f-plan-layers-parallel";
    const log = join(root, `${id}-events.log`);
    writeFileSync(log, "");
    await layeredRun(id, `appendFileSync(${JSON.stringify(log)}, "start\\n");
await new Promise((r) => setTimeout(r, 300));
appendFileSync(${JSON.stringify(log)}, "end\\n");
${APPROVE}`, { concurrency: 8 });
    const run = await planReviewRun(id, 3);
    expect(run.failureReason).toMatch(/達到上限/); // 三個呼叫都成功套用，之後進 implement 時預算用完
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(["start", "start", "start"]); // 索引與兩群同時開始，之後才有人結束
    expect(reviewState(id).reviewed.tasks["T-8"].verdict).toBe("approve");
  });

  it("一個群額度用完時其他呼叫跑完並存檔，resume 只補跑沒完成的", async () => {
    const id = "f-plan-layers-quota";
    const log = join(root, `${id}-calls.log`);
    const flag = join(root, `${id}-quota`);
    writeFileSync(log, "");
    writeFileSync(flag, "");
    // 索引是 slot-0，兩群依序是 slot-1、slot-2；slot-2 額度用完
    await layeredRun(id, `const slot = process.cwd().split("/").pop();
appendFileSync(${JSON.stringify(log)}, kind + ":" + slot + "\\n");
if (slot === "slot-2" && existsSync(${JSON.stringify(flag)})) { console.error("usage limit reached"); process.exit(1); }
${APPROVE}`, { concurrency: 8 });

    const paused = await planReviewRun(id, 3);
    expect(paused.stage).toBe("paused");
    expect(paused.pausedStage).toBe("plan_review");
    expect(readFileSync(log, "utf8").trim().split("\n").sort()).toEqual(["group:slot-1", "group:slot-2", "index:slot-0"]);

    rmSync(flag);
    resetQuotaState(); // 模擬 resume 時是新的程序
    writeFileSync(log, "");
    // 前面已用掉 3 次，這次只剩 1 次可用：剛好夠補跑 slot-2
    const resumed = await planReviewRun(id, 4);
    expect(readFileSync(log, "utf8").trim()).toBe("group:slot-2"); // 索引與 slot-1 沿用存檔，沒有重跑
    expect(resumed.failureReason).toMatch(/達到上限/);
    expect(reviewState(id).reviewed.tasks["T-1"].verdict).toBe("approve");
    expect(reviewState(id).reviewed.tasks["T-8"].verdict).toBe("approve");
  });
```

（`engine.test.ts` 若還沒 import `rmSync`，補在 `node:fs` 的 import 裡。）

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/engine.test.ts -t "分層計畫審查"`
Expected: 遷移後的既有測試仍 PASS；兩個新測試 FAIL（分層現在仍是一個一個跑：第一個測試的事件是 `start,end,start,…`；第二個測試 resume 時會重跑已完成的呼叫，因為過渡寫法每次只存一個）。

- [ ] **Step 3: 實作**

把 `planReviewLayered` 中 `nextSlot`／`runCall` 與後面兩段 `for` 迴圈，整段換成下面這樣。前面的 `author`、`round`、`panel`、`replies`、`statePath`、`reviewed`、`planKey`、`progress`、`saveState`、`done` 都保留：

```ts
  const calls: PlanReviewCall[] = [];
  // 沿用的呼叫也佔一格，重跑時每個呼叫的 slot 才不會變
  let nextSlot = 0;
  interface Item { key: string; taskIds?: string[]; spec: PlanReviewCallSpec; reused?: PlanReviewCall }
  const items: Item[] = [];
  const add = (key: string, taskIds: string[] | undefined, label: string, spec: Omit<PlanReviewCallSpec, "slot" | "key">) => {
    const reused = done.get(key);
    if (reused) info(run, `   ↪ 沿用本輪已完成的${label}（${reused.reviewer}）`);
    else info(run, `🧐 ${label}第 ${round} 輪（${spec.reviewer}，作者 ${author}）`);
    items.push({ key, taskIds, reused, spec: { ...spec, slot: nextSlot++, key } });
  };

  for (const reviewer of panel) {
    add(`index:${reviewer}`, undefined, "計畫索引審查", {
      reviewer, step: "plan-review", gated: true, subject: "計畫索引",
      prompt: renderPrompt("plan-review-index", {
        reviewer, author, requirement: run.requirement,
        index: planReviewIndex(layered.tasks),
        acceptance: JSON.stringify(layered.acceptance, null, 2),
        overview: planOverview(layered.planMd),
        replies,
      }),
      output: "plan-review.json", archive: `plan-review-${round}-${reviewer}.json`,
    });
  }
  for (const group of layered.dirty) {
    const groupTasks = layered.tasks.filter((task) => group.taskIds.includes(task.id));
    const acceptanceIds = new Set(groupTasks.flatMap((task) => task.acceptance));
    const neighbors = neighborTasks(layered.tasks, group.taskIds).map(({ id, title, description, dependsOn }) => ({ id, title, description, dependsOn }));
    const groupPanel = reviewers(run.cycle, author, groupReviewerCount(groupTasks, cfg.planReviewQuorum), `${run.id}:plan-group:${group.id}:${round}`);
    for (const reviewer of groupPanel) {
      add(`group:${group.id}:${group.taskIds.join(",")}:${reviewer}`, group.taskIds, `計畫群 ${group.id} 審查`, {
        reviewer, step: "plan-review-group", gated: false, subject: `任務群 ${group.id}`, scope: group.id,
        prompt: renderPrompt("plan-review-group", {
          reviewer, author, groupId: group.id,
          files: group.files.join("、") || "（這群的描述沒有點名檔案）",
          tasks: JSON.stringify(groupTasks, null, 2),
          neighbors: neighbors.length ? JSON.stringify(neighbors, null, 2) : "（沒有跨群的直接相依）",
          acceptance: JSON.stringify(layered.acceptance.filter((item) => acceptanceIds.has(item.id)), null, 2),
          evidence: extractPlanEvidence(layered.planMd, group.taskIds),
          replies: repliesForTasks(replies, group.taskIds),
        }),
        output: "plan-review-group.json", archive: `plan-review-${round}-${group.id}-${reviewer}.json`,
      });
    }
  }

  // 平行執行還沒套用的呼叫；沿用的（已套用、記在進度檔裡）不再跑
  const pending = items.filter((item) => !item.reused);
  const ran = await executeReviewCalls(run, cfg, "plan-review", `${round}:${planKey}`, pending.map((item) => item.spec));
  if (!ran) return run;

  // 序列收尾，依原本的順序逐一套用；每套用一個就寫進度檔，中途被中斷也不會重複套用
  const applied = new Map<string, PlanReviewCall>();
  for (const [i, item] of pending.entries()) {
    const passed = applyPlanReview(run, item.spec, ran.finished[i]!, ran.dir);
    run = passed.run;
    if (!passed.collected) return run;
    // 真的執行並成功就是有進展：同一輪不同呼叫輪流失敗時，不會累計到重試上限而讓 run 失敗。
    // 進度寫在 round 裡、不會重跑，所以一輪最多失敗「呼叫數 × maxAttempts」次。
    // 整份審查每次重跑整輪，不能這樣歸零，否則同一位審查者反覆失敗會無限重試。
    const attempts = { ...run.attempts };
    delete attempts["plan-review-run"];
    run = { ...run, attempts };
    const call: PlanReviewCall = { key: item.key, ...passed.collected, ...(item.taskIds ? { taskIds: item.taskIds } : {}) };
    progress.calls.push(call);
    applied.set(item.key, call);
    saveState({ version: 1, ...(reviewed ? { reviewed } : {}), round: progress });
  }
  calls.push(...items.map((item) => item.reused ?? applied.get(item.key)!));
```

之後接原本的 `groupVerdicts`、`saveState`、`concludePlanReview`（不變）。刪掉 Task 6 的過渡寫法。

- [ ] **Step 4: 執行確認通過**

Run: `pnpm run typecheck && npx vitest run src/parallelEngine.test.ts src/engine.test.ts src/planReview.test.ts`
Expected: PASS（既有「分層計畫審查」測試全部仍過）

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts src/parallelEngine.test.ts
git commit -m "feat: 分層計畫審查的索引與各群審查平行執行

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 程式碼審查改為平行

**Files:**
- Modify: `src/engine.ts:codeReview`
- Test: `src/parallelEngine.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `executeReviewCalls`、`replay`、`storedOutcome`、`ReviewCall`、`Finished`；`dropCall`（Task 4）

- [ ] **Step 1: 寫失敗的測試**

在 `src/parallelEngine.test.ts` 加程式碼審查用的 run 與測試：

```ts
async function codeReviewSetup(id: string, mode: "close" | "open" = "close") {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  writeFileSync(join(worktreeDir(id), "feature.ts"), "export const answer = 42;\n");
  await commitAll(worktreeDir(id), "feat: 測試功能 [a]");
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "review-mode.txt"), mode);
  writeFileSync(join(flowDir(id), "acceptance.json"), JSON.stringify([{ id: "AC-1", description: "匯出 answer" }]));
  const source = { stage: "implement" as const, step: "T-1-code", agent: "a", callKey: `${id}:code` };
  mergeHandoff(id, source.callKey, source, { newIssues: [{ kind: "action", summary: "測試待核對", evidence: "src/api.test.ts:20", targetStage: "code" }], dispositions: [] }, "writer");
}

describe("程式碼審查平行", () => {
  it("兩位審查者同時執行", async () => {
    const id = "pe-code-par";
    configure(writeReviewer("reviewer.mjs"), { reviewQuorum: 2 });
    await codeReviewSetup(id);
    resetEvents();
    setFlag("sleep", "300");
    const run = await advance(baseRun(id, "review", { lastWriter: "a", stopAfter: "review" }));
    clearFlag("sleep");
    expect(run.stage).toBe("paused");
    expect(events().slice(0, 2).every((line) => line.startsWith("start"))).toBe(true);
  });

  it("審查者亂改程式碼與 .flow 不會動到共用的 worktree", async () => {
    const id = "pe-code-tamper";
    configure(writeReviewer("reviewer.mjs"));
    await codeReviewSetup(id);
    setFlag("tamper");
    const before = readFileSync(join(flowDir(id), "acceptance.json"), "utf8");
    const run = await advance(baseRun(id, "review", { lastWriter: "a", stopAfter: "review" }));
    clearFlag("tamper");
    expect(run.stage).toBe("paused");
    expect(readFileSync(join(flowDir(id), "acceptance.json"), "utf8")).toBe(before);
    expect(readFileSync(join(worktreeDir(id), "feature.ts"), "utf8")).toBe("export const answer = 42;\n");
    expect(execFileSync("git", ["-C", worktreeDir(id), "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it("額度用完後 resume 只補跑沒完成的審查者", async () => {
    const id = "pe-code-quota";
    configure(writeReviewer("reviewer.mjs"), { reviewQuorum: 2 });
    await codeReviewSetup(id);
    resetEvents();
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "review", { lastWriter: "a" }));
    expect(paused.stage).toBe("paused");
    clearFlag("quota-slot-1");

    resetQuotaState();
    resetEvents();
    const resumed = await advance({ ...paused, stage: "review", pausedStage: undefined, pauseReason: undefined });
    expect(resumed.stage).toBe("done");
    expect(events()).not.toContain("start slot-0");
    expect(events()).toContain("start slot-1");
  });

  it("HEAD 變了（程式碼被修過）就不沿用舊的審查結果", async () => {
    const id = "pe-code-stale";
    configure(writeReviewer("reviewer.mjs"), { reviewQuorum: 2 });
    await codeReviewSetup(id);
    setFlag("quota-slot-1");
    const paused = await advance(baseRun(id, "review", { lastWriter: "a" }));
    clearFlag("quota-slot-1");
    writeFileSync(join(worktreeDir(id), "feature.ts"), "export const answer = 43;\n");
    await commitAll(worktreeDir(id), "fix: 改答案 [a]");

    resetQuotaState();
    resetEvents();
    await advance({ ...paused, stage: "review", pausedStage: undefined, pauseReason: undefined });
    expect(events()).toContain("start slot-0"); // 指紋變了，舊結果作廢，重跑
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/parallelEngine.test.ts -t "程式碼審查平行"`
Expected: FAIL（程式碼審查仍是序列、resume 會重跑 slot-0）。

- [ ] **Step 3: 實作**

`codeReview` 內，把 `const issues…` 之後到 `if (opts.step === "review") run = clearModelReviewStage(run, "review");` 之前的整個 `for` 迴圈換成：

```ts
  const specs: ReviewCall[] = panel.map((reviewer, slot) => ({
    key: `${slot}:${reviewer}`, slot, reviewer, step: opts.step,
    prompt: opts.prompt(reviewer, authors.join("、") || "未知"),
    output: "review.json",
  }));
  for (const spec of specs) info(run, `👀 ${opts.label}（${spec.reviewer}）`);
  // 指紋含 HEAD：程式碼被修過就不沿用舊的審查結果
  const ran = await executeReviewCalls(run, cfg, opts.step, `${opts.seed}|${await headCommit(repo)}|${opts.base}`, specs);
  if (!ran) return { run };

  const issues: string[] = [];
  let objector: string | undefined;
  for (const [i, spec] of specs.entries()) {
    const reviewer = spec.reviewer;
    const done = ran.finished[i]!;
    const fail = (reason: string, category: RetryCategory) => {
      dropCall(ran.dir, spec.key); // 不合格的存檔不能留著，否則同一輪重跑會讀到同一份
      return { run: retry(opts.step === "review" ? recordModelReviewFailure(run, "review", reviewer) : run, opts.runKey, reason, opts.backTo, category) };
    };
    if (!done.ok) return fail(`Agent 執行失敗：${done.stored.summary}`, "agent_error");
    replay(run, done.stored, "review.json");
    const review = readJsonFile(flowFile(run, "review.json"), ConsistentReviewResult);
    if (!review.ok) return fail(review.error, "format_invalid");
    const gate = opts.gate ? { target: "code" as const, verdict: review.data.verdict } : undefined;
    const handoffError = finishHandoff(run, storedOutcome(done.stored, true), "reviewer", gate);
    if (handoffError) return fail(handoffError, "handoff_invalid");
    if (opts.step === "review") run = clearModelReviewFailure(run, "review", reviewer);
    renameSync(flowFile(run, "review.json"), flowFile(run, opts.saveAs(reviewer)));
    if (review.data.verdict === "approve") {
      info(run, `   ✓ ${reviewer} 核准`);
      continue;
    }
    info(run, `   ✗ ${reviewer} 要求修改`);
    objector ??= reviewer;
    issues.push(opinion(reviewer, review.data.items
      .filter((i) => i.status !== "met")
      .map((i) => reviewIssue(i.criterion, i.status, i.note))));
  }
```

（原本 `const issues: string[] = []; let objector…` 兩行已被上面取代，刪掉原本那兩行。其餘 `clearModelReviewStage`、`attempts`、回傳照舊。）

- [ ] **Step 4: 執行確認通過**

Run: `pnpm run typecheck && pnpm test`
Expected: 全部 PASS。若 typecheck 報 `snapshotPlan`／`restorePlan`／`LOCKED_FILES`／`discardChanges` 已不再使用，刪掉未使用的部分；仍被使用的不要動。

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/parallelEngine.test.ts
git commit -m "feat: 程式碼審查的審查者平行執行

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 收尾驗證

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-parallel-reviewers-design.md`（若實作與 spec 有出入才改）

- [ ] **Step 1: 全套驗證**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: 全部通過。

- [ ] **Step 2: 手動 stop／resume 演練**

在一個有至少兩位已安裝 agent 的測試專案跑：

```bash
pnpm dev run "<小需求>" --stop-after plan   # 或任何會進計畫審查的需求
```

在計畫審查進行中按 Ctrl-C。然後：

```bash
ls .agentflowctl/runs/<id>/tmp-review 2>/dev/null   # 可能有殘骸
git worktree list                                   # 可能有殘留的 tmp-review 登記
pnpm dev resume <id>
git worktree list                                   # 殘骸應已清掉
```

Expected: resume 後 `tmp-review` 不存在、`git worktree list` 沒有臨時 worktree，終端機出現 `↪ 沿用本輪已完成的審查`（若中斷前已有審查者完成），run 順利往下走。

- [ ] **Step 3: 對照 spec 逐條確認**

逐節對照 spec：§1 臨時 worktree、§2 執行器（限流、預算、額度）、§3 存檔（指紋、失敗不存、不合格刪除）、§4 序列收尾與冪等、§5 孤兒清理、§6 前綴與 log 序號、§7 設定與 README。有落差的補測試或修 spec。

- [ ] **Step 4: 開 PR**

詢問使用者是否要 push 並開 PR（不要自行 push）。
