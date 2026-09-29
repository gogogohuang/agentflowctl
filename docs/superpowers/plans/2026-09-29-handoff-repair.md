# 交接回覆不合格時保留工作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 寫作類 agent 完成了工作、關卡（測試／diff）也通過，只是 `.flow/handoff-response.json` 不合格時，不再 `resetTo` 丟掉整份工作重跑，而是請同一家 agent 只補寫一次交接回覆。

**Architecture:** 在 `engine.ts` 新增 `settleHandoff()`：先照舊呼叫 `finishHandoff`；失敗才記下目前 HEAD（已通過關卡的 commit），用新的 `handoff-repair` prompt 再叫同一家 agent 一次（不換人、不 reset），補寫後一律 `resetTo` 回那個 commit 並還原鎖定的計畫檔，再驗一次交接。`resetTo` 同時清掉補寫呼叫自行建立的 commit，所以補寫無法繞過測試、diff 等關卡。仍失敗才回傳錯誤，由呼叫端走原本的「還原並重試」。只套用在程式碼端的三個寫作點（紅燈測試、綠燈實作、fix）。

**Tech Stack:** TypeScript、vitest、zod（不新增依賴）。

**Spec:** 無獨立 spec。動機與資料見對話中的花費分析：`f-mulcedrq` 一次 run 有 3 次 `handoff_invalid`（T-1:fix ×2、T-10:fix ×1），每次都還原並重跑整個 fix（約 100 萬 tokens）。既有交接設計見 `docs/superpowers/specs/2026-09-26-agent-handoff-design.md`。

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。
- 關卡判斷以程式能檢查的事實為準；補寫呼叫不得改變關卡結果（測試、diff、鎖定計畫檔）。補寫後一律 `resetTo` 回補寫前的 HEAD，連補寫 agent 自行 commit 的內容也一併丟棄。
- 使用者看得到的行為有變動，同一個 commit 要更新 `README.md`。
- 每個 prompt 都要有 `<role>`（以「你是」開頭，且角色名稱與其他 prompt 不同）、`<reply_format>`、`<result>`，並提到 `.flow/handoff-context.md`、`.flow/handoff-response.json`、`"newIssues": []`、`"dispositions": []`（`src/prompts.test.ts` 會檢查）。
- 不新增 `RetryCategory`、不新增 run 狀態欄位、不新增 `ModelStage`（補寫沿用原步驟名稱選模型）。
- 不動審查者端的交接（`finishHandoff(..., "reviewer")`）：審查者失敗是 verdict 與事項矛盾，需要重新審查，不是格式問題。
- 不動 spec／plan／plan-fix 三個計畫端寫作點（本計畫範圍外，見最後「後續」）。

## File Structure

- Create: `prompts/handoff-repair.md`：補寫交接的專用 prompt。
- Modify: `src/prompts.test.ts`：測試用變數表加上 `step`、`error`、`range`。
- Modify: `src/engine.ts`：`StepMode` 加 `pinned`；`agentStep` 額度處理；新增 `settleHandoff`；三個呼叫處改用它。
- Modify: `src/engine.test.ts`：補寫成功、補寫仍失敗、補寫動到未 commit 檔案、補寫自行 commit 四種情境，以及紅燈、綠燈各一個。
- Modify: `README.md`、`docs/reference.md`：說明新行為。

---

### Task 1: handoff-repair prompt

**Files:**
- Create: `prompts/handoff-repair.md`
- Modify: `src/prompts.test.ts:9-29`（`vars`）

**Interfaces:**
- Consumes: `renderPrompt(name, vars)`（`src/util.ts`），缺變數會丟錯。
- Produces: prompt 名稱 `handoff-repair`，變數：
  - `{{step}}`：原步驟名稱，如 `T-1-fix`
  - `{{error}}`：`finishHandoff` 回傳的錯誤字串
  - `{{range}}`：這一步的變更範圍 `<base>..<head>`（例如紅燈是 `before..測試 commit`）；base 與 head 相同時代表這一步沒有產生 commit

這個 Task 沒有真正的紅燈：`prompts.test.ts` 用 `it.each(names)` 掃描 `prompts/` 目錄，新 prompt 建立後才會被納入測試。

- [ ] **Step 1: 加測試變數**

在 `src/prompts.test.ts` 的 `vars` 物件最後（`replies: "",` 之後）加上：

```ts
  step: "T-1-fix",
  error: "handoff-response.json 不存在",
  range: "abc1234..def5678",
```

- [ ] **Step 2: 建立 `prompts/handoff-repair.md`**

````markdown
<role>
你是交接紀錄員，只負責補寫上一個步驟沒有寫好的 .flow/handoff-response.json。工作本身已經完成並通過檢查，不要重做。
</role>

<context>
目前的工作目錄就是專案（agentflowctl 為這次任務建立的專用 git worktree）。
步驟 {{step}} 的工作已完成，變更範圍是 `{{range}}`，但交接回覆沒有通過檢查，原因：

{{error}}
</context>

<handoff>
先閱讀 .flow/handoff-context.md，確認有哪些待處理事項。再寫入 .flow/handoff-response.json；即使沒有事項也必須寫出空陣列：

```json
{ "newIssues": [], "dispositions": [] }
```

新增事項格式：{ "kind": "action 或 info", "summary": "具體問題", "evidence": "檔案位置或檢查證據", "targetStage": "plan 或 code" }。
處置格式：{ "id": "既有事項 ID", "status": "proposed_resolved", "reason": "具體處理理由", "evidence": "檔案、commit 或檢查結果" }。只有「待處理事項」（action）可以處置，而且這個步驟的作者只能用 proposed_resolved；「參考資訊」（info）不要放進 dispositions。
</handoff>

<inputs>
- .flow/handoff-context.md：待處理事項與參考資訊
- `git log {{range}}` 與 `git diff {{range}}`：這一步實際做了什麼，處置的理由與證據要以它為準。範圍兩端相同代表這一步沒有產生 commit，這時不要把任何事項標成已處理
</inputs>

<steps>
1. 讀 .flow/handoff-context.md 與上述 git 範圍，判斷每個待處理事項這一步有沒有真的處理；沒有把握的事項不要處置。
2. 只寫入 .flow/handoff-response.json，格式如上。
</steps>

<constraints>
- 只能建立或修改 .flow/handoff-response.json。其他檔案的變更與任何 git commit 都會在你結束後被自動丟棄，不會生效。
- 不要重做或改善這一步的工作，也不要重新跑完整測試。
</constraints>

<reply_format>
完成後，回覆的最後必須附上以下 XML 中繼資料（只附一次，標籤名稱不可更改）：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>一兩句說明補寫了什麼；blocked 時說明卡在哪裡</summary>
  <files_changed>
    <file>.flow/handoff-response.json</file>
  </files_changed>
  <concerns>沒有就留空</concerns>
</result>
```
</reply_format>
````

- [ ] **Step 3: 執行測試確認通過**

Run: `npx vitest run src/prompts.test.ts`
Expected: PASS（新 prompt 被 `it.each(names)` 涵蓋；角色「交接紀錄員」與其他 prompt 不重複）。

- [ ] **Step 4: Commit**

```bash
git add prompts/handoff-repair.md src/prompts.test.ts
git commit -m "新增 handoff-repair prompt：只補寫交接回覆"
```

---

### Task 2: settleHandoff 與 fix 階段

**Files:**
- Modify: `src/engine.ts:86-93`（`StepMode`）、`src/engine.ts:121-124`（額度分支）、`src/engine.ts:155` 之後（新增 `settleHandoff`）、`src/engine.ts:970-974`（`applyFix`）
- Test: `src/engine.test.ts`
- Modify: `README.md`、`docs/reference.md`（只說明 fix 的補寫行為）

**Interfaces:**
- Consumes: `finishHandoff(run, outcome, role, gate?) => string | undefined`（`engine.ts:156`）；`agentStep`；`QuotaPause`；`headCommit`、`resetTo`（`git.ts`）；`restorePlan`、`snapshotPlan`。
- Produces:
  - `StepMode.pinned?: boolean`：額度用完時不找代打，直接丟 `QuotaPause`。
  - `async function settleHandoff(run, outcome, base, restore): Promise<string | undefined>`：
    - `base: string`：這一步開始前的 commit，用來組出給 prompt 的變更範圍
    - `restore: () => void`：還原鎖定計畫檔（呼叫端傳 `() => { restorePlan(run, snap); }`）
    - 回傳 `undefined` 代表交接已接受；回傳字串代表補寫也失敗，呼叫端照舊還原並重試

- [ ] **Step 1: 寫失敗的測試**

在 `src/engine.test.ts` 加一個 `describe("交接補寫", ...)`。參考 `reviewRun` 的建立方式（`addWorktree`、`commitAll`、`mergeHandoff`），建立一個 `stage: "fix"`、`fixSource: "verify"` 的 run，並在 `.flow/feedback.md` 寫入 `"檢查失敗"`。

fix agent 用新的 command 腳本。command adapter 在設定沒有 `{prompt}` 佔位符時從 stdin 傳 prompt（`src/agents/command.ts:5、18`），所以腳本讀 stdin：

```ts
const repairScript = join(root, "repair.mjs");
writeFileSync(repairScript, `import { execSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const behavior = readFileSync(".flow/repair-mode.txt", "utf8").trim();
const repairing = prompt.includes("交接紀錄員");
appendFileSync(".flow/calls.txt", repairing ? "repair\\n" : "fix\\n");
if (repairing) {
  if (behavior !== "repair-bad") writeFileSync(".flow/handoff-response.json", JSON.stringify({ newIssues: [], dispositions: [] }));
  if (behavior === "repair-tamper" || behavior === "repair-commit") writeFileSync("evil.ts", "export {};\\n");
  if (behavior === "repair-commit") execSync("git add -A && git -c user.name=t -c user.email=t@t commit -qm evil");
  process.exit(0);
}
writeFileSync("fixed.ts", "export const fixed = true;\\n");
writeFileSync(".flow/handoff-response.json", "{ 壞掉的 json");
`);
```

`fixRun(id, mode)` 是你在此 describe 內寫的小工具：建 worktree、寫 `.flow/repair-mode.txt` 與 `.flow/feedback.md`、把 config 的 agent 指到 `repairScript`、以 `maxAgentRuns: 2` 呼叫 `advance`，回傳結束後的 run。

`advance` 沒有「離開 fix 就停」的選項（`autopilot` 只管計畫核准），所以靠 agent 預算截斷：fix 與補寫共用掉 2 次，下一次迴圈開頭的預算檢查（`engine.ts:1125`）會讓 run 以 `agent_budget` 失敗，`failedStage` 就是 fix 之後要進的階段。

四個測試：

```ts
it("fix 的交接不合格時只補寫交接，保留修正的 commit", async () => {
  const run = await fixRun("f-repair-ok", "repair-ok");
  expect(run).toMatchObject({ stage: "failed", failedStage: "verify", failureCategory: "agent_budget" });
  expect(listRetries(run.id).some((r) => r.category === "handoff_invalid")).toBe(false);
  expect(readFileSync(join(flowDir(run.id), "calls.txt"), "utf8")).toBe("fix\nrepair\n");
  expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
});

it("補寫後仍不合格時還原修正並照舊重試", async () => {
  const run = await fixRun("f-repair-bad", "repair-bad");
  expect(run).toMatchObject({ stage: "failed", failedStage: "fix", failureCategory: "agent_budget" });
  expect(listRetries(run.id).map((r) => r.category)).toContain("handoff_invalid");
  expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(false);
});

it("補寫呼叫動到其他檔案時會被還原", async () => {
  const run = await fixRun("f-repair-tamper", "repair-tamper");
  expect(run).toMatchObject({ failedStage: "verify" });
  expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
  expect(existsSync(join(worktreeDir(run.id), "evil.ts"))).toBe(false);
});

it("補寫呼叫自行 commit 時也會被丟棄", async () => {
  const run = await fixRun("f-repair-commit", "repair-commit");
  expect(run).toMatchObject({ failedStage: "verify" });
  expect(existsSync(join(worktreeDir(run.id), "fixed.ts"))).toBe(true);
  expect(existsSync(join(worktreeDir(run.id), "evil.ts"))).toBe(false);
  const log = await git(worktreeDir(run.id), "log", "--format=%s");
  expect(log).not.toContain("evil");
});
```

（`git` 的 import 與回傳型別依 `src/git.ts` 實際簽章調整。）

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/engine.test.ts -t "交接補寫"`
Expected: 第一、三、四個測試 FAIL（現在會有 `handoff_invalid`，calls 只有 `fix\n`，`failedStage` 是 `fix`）。

- [ ] **Step 3: 實作**

`StepMode` 加欄位：

```ts
  /** 額度用完時不找代打，直接暫停；補寫交接這類必須由原 agent 做的小呼叫使用 */
  pinned?: boolean;
```

`agentStep` 額度分支改為：

```ts
    if (exhausted.has(agent)) {
      if (mode.kind === "review" || mode.pinned) {
        throw new QuotaPause(`${agent} 的額度已用完；${step} 不由另一家代打`);
      }
```

在 `finishHandoff` 之後新增：

```ts
/**
 * 寫作步驟的交接：關卡已通過，交接回覆不合格時不丟掉工作，請同一家 agent 只補寫一次。
 * 補寫前記下 HEAD，補寫後一律 reset 回去並還原計畫檔，連補寫自行建立的 commit 也丟棄，
 * 所以補寫無法改變已通過的關卡。補寫仍失敗（或額度用完）就回傳錯誤，由呼叫端照舊還原並重試。
 */
async function settleHandoff(
  run: FlowRun, outcome: StepOutcome, base: string, restore: () => void,
): Promise<string | undefined> {
  const first = finishHandoff(run, outcome, "writer");
  if (!first) return undefined;
  const repo = worktreeDir(run.id);
  const settled = await headCommit(repo);
  const cleanup = async () => { await resetTo(repo, settled); restore(); };
  info(run, `📎 交接回覆不合格，請 ${outcome.agent} 只補寫交接（不重做工作）：${first}`);
  let repair: StepOutcome;
  try {
    repair = await agentStep(
      run, outcome.agent, outcome.step,
      renderPrompt("handoff-repair", { step: outcome.step, error: first, range: `${base}..${settled}` }),
      { kind: "write", pinned: true, reset: cleanup },
    );
  } catch (error) {
    if (error instanceof QuotaPause) return first;
    throw error;
  } finally {
    await cleanup();
  }
  if (!repair.r.ok) return `${first}（補寫交接時 Agent 執行失敗：${repair.r.summary}）`;
  return finishHandoff(run, repair, "writer");
}
```

`cleanup` 可重複執行：補寫呼叫若回報額度耗盡，`agentStep` 會先透過 `reset` 執行一次，`finally` 仍會再執行，以涵蓋 `runAgent` 或後續記錄流程拋出非 `QuotaPause` 錯誤的情況。`.flow/` 在 `info/exclude` 內，`resetTo` 的 `git clean -fd` 不會刪掉補寫的 `handoff-response.json`；`agentStep` 內的 `prepareHandoff` 會在補寫前先刪掉舊的壞檔。

`applyFix`（約 `engine.ts:970`）改成：

```ts
  const handoffError = await settleHandoff(run, outcome, before, () => { restorePlan(run, snap); });
```

其餘 `if (handoffError) { await resetTo(repo, before); ... }` 不變。

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/engine.test.ts -t "交接補寫" && pnpm run typecheck`
Expected: PASS。

- [ ] **Step 5: 跑全部測試**

Run: `pnpm test`
Expected: 全過。既有的 `handoff_invalid` 測試（`engine.test.ts:75、129、820`）都在審查者端，不受影響；若有失敗，檢查是否某個測試的 fake agent 對第二次呼叫沒有處理。

- [ ] **Step 6: 更新文件**

`grep -n "交接" README.md docs/reference.md` 找到描述交接／重試的位置，加：「fix 完成且通過關卡後，若 `.flow/handoff-response.json` 不合格，會請同一家 agent 再呼叫一次，只補寫交接（不重做工作，也不換人代打）；補寫期間對其他檔案的變更與 commit 一律丟棄。補寫仍不合格或額度用完，才照舊還原這一步並重試。補寫呼叫記在原步驟名稱底下，`stats` 與 `logs` 會多一筆，也會計入 `--max-agent-runs` 的次數。」

- [ ] **Step 7: Commit**

```bash
git add src/engine.ts src/engine.test.ts README.md docs/reference.md
git commit -m "fix 階段交接回覆不合格時只補寫交接，不再還原整份修正"
```

---

### Task 3: 紅燈測試與綠燈實作兩個寫作點

**Files:**
- Modify: `src/engine.ts:792-796`（紅燈）、`src/engine.ts:832-836`（綠燈）
- Test: `src/engine.test.ts`
- Modify: `README.md`、`docs/reference.md`（把 Task 2 那段的適用範圍改成紅燈測試、綠燈實作與 fix）

**Interfaces:**
- Consumes: Task 2 的 `settleHandoff(run, outcome, base, restore)`。
- Produces: 無新介面。

- [ ] **Step 1: 寫失敗的測試**

仿 Task 2 的 `fixRun`，同樣以 `maxAgentRuns: 2` 截斷，各加一個情境：

- `taskPhase: "tests"`：agent 寫出符合 `testPattern` 的失敗測試與壞掉的交接檔，補寫後應為 `taskPhase: "code"`、`failedStage: "implement"`、`testsCommit` 已設定。
- `taskPhase: "code"`：agent 寫出讓測試通過的實作與壞掉的交接檔，補寫後應為 `taskPhase: "review"`、`failedStage: "implement"`。

兩者都斷言 `listRetries` 沒有 `handoff_invalid`。任務與 `tasks.ordered.json` 的建立參考現有 implement 相關測試；沒有現成夾具就用最小 tasks（一個任務、一個驗收條件）。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/engine.test.ts -t "交接補寫"`
Expected: 新的兩個測試 FAIL。

- [ ] **Step 3: 實作**

紅燈（`engine.ts` 約 792）：

```ts
    const handoffError = await settleHandoff(run, outcome, before, () => { restorePlan(run, snap); });
```

綠燈（約 832），base 是測試 commit：

```ts
  const handoffError = await settleHandoff(run, outcome, testsCommit, () => { restorePlan(run, snap); });
```

兩處後面的 `if (handoffError) { await resetTo(...); return retry(...) }` 不變。紅燈的 `red-output.txt` 在 handoff 之後才寫，不受補寫的 `resetTo` 影響。

- [ ] **Step 4: 更新文件**

把 Task 2 在 `README.md`、`docs/reference.md` 加的那段開頭「fix 完成且通過關卡後」改成「寫作類步驟（紅燈測試、綠燈實作、fix）完成且通過關卡後」。

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm test && pnpm run typecheck`
Expected: 全過。

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts README.md docs/reference.md
git commit -m "紅燈測試與綠燈實作的交接回覆不合格時也只補寫交接"
```

---

## Self-Review

- **Spec coverage：** 「交接不合格不丟工作」→ Task 2、3；「補寫不能繞過關卡」→ `settleHandoff` 以 `resetTo(settled)` 清掉未 commit 變更與自行 commit，Task 2 各有測試；「不新增類別／欄位」→ 遵守；README → Task 2、3 各自的行為 commit。
- **Placeholder：** 測試夾具 `fixRun` 需要實作者依既有 `reviewRun` 補完，已說明依據、必要欄位與截斷方式（`maxAgentRuns: 2`）。
- **型別一致：** `settleHandoff(run, outcome, base, restore)` 三處呼叫簽章一致；`pinned` 只在 `StepMode` 與額度分支使用。

## 已知取捨與後續

- 補寫的 agent 沒有原本的對話記憶，只能靠 `git diff {{range}}` 判斷處置；沒把握時 prompt 要求不處置，所以最壞情況是事項仍為 open、之後由審查者處理。
- 補寫沿用原步驟的模型強度，成本約等於一次很短的呼叫（讀 diff、寫一個 JSON），但會多占一次 `maxAgentRuns`。若之後想固定用低強度模型，要新增 `ModelStage`，牽動 `modelConfig`、`schemas`、README，另案處理。
- 補寫時額度用完不暫停，直接回到原本的還原並重試（計一次 `handoff_invalid`），下一次嘗試會由代打處理。
- 後續：spec／plan／plan-fix 的三個計畫端寫作點（`engine.ts:250、336、648`）可以套用同一個 `settleHandoff`，但它們的「還原」是 `restorePlan`／`discardChanges`，且計畫檔在 handoff 之後才 `acceptPlan`，補寫期間需保護計畫檔，先觀察程式碼端的效果再決定。
