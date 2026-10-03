# 平行流程恢復 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同一個 run 的平行 agent 呼叫不超過執行額度，車道基礎設施例外完整收束，並讓 replan 後的 PR 人工確認資料只反映目前計畫。

**Architecture:** 在 `store.ts` 建立只存在程序記憶體、以 owner run id 共用的 reservation 計數，`agentStep()` 在啟動 CLI 前保留名額並以 `finally` 釋放；平行審查也移除自行預扣的額度邏輯，改依此單一機制。`scheduleLanes()` 將 `start`／`merge` rejection 正規化為車道失敗 outcome，持續等待既有車道結束。`separateHumanItems()` 則每次從當前 `.flow/` 三份計畫檔重建確認檔，而不是合併舊快照；因為定案後 confirm 項目已從 `.flow/` 搬走，`replanRun` 要先把它們併回 `.flow/`，否則重建會清空既有確認項目。額度不足時丟專用 `AgentBudgetError`，在 `advance`、車道與平行審查三處一律映射成 `agent_budget` 失敗。

**Tech Stack:** TypeScript（Node >= 22）、vitest、zod、pnpm。

**Spec:** `docs/superpowers/specs/2026-10-03-parallel-flow-recovery-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。
- 不新增 CLI 選項，不變更 `.flow/`、run state 或用量 JSONL 的既有格式。
- reservation 只存在程序記憶體；resume 仍只由 `costs.jsonl` 回復已使用次數。
- 關卡判斷以程式能檢查的事實為準。
- 使用者看得到的行為變更必須在同一個 commit 更新 `README.md`；本變更不新增選項或改變成功流程，若確認沒有可見說明需改，於最終檢查明載此結論。
- 每個 commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 驗證指令：`pnpm run typecheck`、`npx vitest run <檔案>`、`pnpm test`、`pnpm run build`。

## Review Focus

- CLI 在 `runAgent()` 尚未回傳前同步拋錯時，reservation 必須仍釋放，後續呼叫不可被幽靈名額阻擋。
- 同一 parent run 的 lane 使用 owner id 寫入用量時，reservation 也必須以 owner id 共用，而非 lane id。
- 平行審查已有可重用存檔且只剩一格額度時，只有真正要執行的新呼叫才需要 reservation，重用結果不應佔位。
- `start()` 或 `merge()` 拋出非 `Error` 值時，失敗原因仍須可安全顯示並帶上對應 task id。
- 額度不足不可變成 `QuotaPause`（暫停）或一般 `error`；三條路徑都要得到 `failureCategory: "agent_budget"`，並保留 `resume --max-agent-runs` 提示。
- 只加備註或 `--no-review` 的 replan 不可清掉未被動到的既有確認項目、驗收條件與計畫段落。
- `hooks.amend()` 與 `driveLane()` 的 `prepareLane()` 拋例外時同樣要收束，多個失敗原因不可被 `??=` 丟掉。
- replan 後沒有任何 `confirm` 任務時，兩份確認資料檔都必須存在且分別為 `[]`、`{ "acceptance": [], "plan": {} }`。

---

### Task 1: Owner run 執行額度 reservation

**Files:**
- Modify: `src/store.ts:1-16, 140-145`
- Modify: `src/store.test.ts`
- Modify: `src/engine.ts:135-180, 610-640, 1595-1598, 2085-2142`（`agentStep`、`executeReviewCalls`、`driveLane` 預先檢查、`advance` 的 catch）
- Test: `src/engine.test.ts` 或 `src/parallelEngine.test.ts`

**Interfaces:**
- Produces `reserveAgentRun(id: string, max: number): boolean`：當 `agentRuns(id) + reservations(id) < max` 時遞增並回傳 `true`，否則不改變狀態並回傳 `false`。
- Produces `releaseAgentRun(id: string): void`：釋放一個 reservation；沒有 reservation 時不得變成負數。
- Produces `resetAgentRunReservations(): void`，僅供測試清理程序內狀態。
- Produces `AgentBudgetError`（`engine.ts` 內 export 的 Error 子類）：保留失敗時由 `agentStep()` 丟出，訊息含已執行數、上限與 `resume --max-agent-runs` 提示。
- `agentStep()` 在每次實際 `runAgent()` 前使用 `ownerId(run.id)` 取得／釋放 reservation；替代 agent 的重試是下一次獨立 reservation。

- [ ] **Step 1: 寫 store reservation 的失敗測試**

在 `src/store.test.ts` 新增以新 run id 驗證：已有一筆 `addUsage`、上限為 3 時前兩次 `reserveAgentRun` 回傳 `true`、第三次回傳 `false`；釋放一次後再次保留成功；重複釋放不會使額度超出；`resetAgentRunReservations` 清空暫存狀態。此測試防止「平行呼叫只看已落盤 usage」的回歸。

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run src/store.test.ts -t "reservation"`

Expected: FAIL，因 `reserveAgentRun`、`releaseAgentRun` 尚未匯出。

- [ ] **Step 3: 在 `src/store.ts` 實作記憶體 reservation**

用模組私有的 `Map<string, number>` 儲存已保留數。`reserveAgentRun` 必須在一次同步操作中讀 usage 和計數、判斷並遞增；`releaseAgentRun` 對最後一格使用 `delete`，未知 id 是 no-op。不要寫入 JSONL 或 state，也不要讓 lane id 繞過 `sharedRunDir` 的 owner 語意。

- [ ] **Step 4: 寫平行額度的失敗整合測試**

在 `src/parallelEngine.test.ts`（若現有 fixture 已能建立平行呼叫則沿用）新增一個案例：設定兩個可同時開始的 lane、先寫入讓 parent run 只剩一格的 usage、以會暫停的假 agent 保持第一個 CLI 呼叫尚未結束，斷言第二個 agent 命令尚未被啟動。釋放第一個後讓流程收束，並斷言 run 因額度而停止、實際新 usage 不超過上限。測試必須透過真正的 `advance()`／lane 流程觀察，不測私有 Map。

- [ ] **Step 5: 確認整合測試失敗**

Run: `npx vitest run src/parallelEngine.test.ts -t "剩餘一格額度"`

Expected: FAIL，現行兩個 lane 都會在 usage 寫入前通過額度檢查並啟動。

- [ ] **Step 6: 把 reservation 接到 `agentStep()` 與平行審查**

在 `engine.ts` 匯入三個 store helper，並在呼叫 `runAgent()` 前取得 `ownerId(run.id)` 的 reservation；若保留失敗，丟出 `AgentBudgetError`（訊息使用目前已執行數與上限；不用 `QuotaPause`，那會讓 run 變成暫停）。以最小 `try/finally` 包住**僅**實際 agent 呼叫與其用量寫入，確保成功、一般失敗、quota exhausted、同步／非同步例外都釋放。

移除 `executeReviewCalls()` 目前以本地 `budget--` 篩掉 call 的預扣邏輯，以及 `driveLane()` 在每次 `implementStage` 前的 `agentRuns` 預先檢查；它們都會超賣。`executeReviewCalls()` 應把所有尚未存檔的 calls 交給 `runPool`，由 `agentStep()` 原子決定誰能啟動，保留已存檔 call 的重用行為。`executeOne()` 要像處理 `QuotaPause` 一樣收下 `AgentBudgetError`（回傳 `{ budget: message }`），已開始的審查先收束，全部結束後才丟出 `AgentBudgetError`。

在 `advance()` 的 catch 把 `AgentBudgetError` 存成 `failureCategory: "agent_budget"`（沿用既有的失敗訊息格式）；在 `driveLane()` 的 catch 回報 `{ kind: "failed", category: "agent_budget", reason }`，且不要把車道本身標成需重置的一般錯誤。

在 `resetQuotaState()` 同時呼叫 `resetAgentRunReservations()`，使既有測試的模擬新程序不殘留名額。

- [ ] **Step 6b: 額度不足分類的測試**

在 `src/parallelEngine.test.ts` 新增：（1）車道路徑：額度只剩零格時 run 以 `failureCategory === "agent_budget"` 失敗，不是 `error` 也不是 `paused`，訊息含調高上限提示；（2）平行審查：三位審查者、只剩一格，一位完成並存檔，其餘不啟動，最後 run 以 `agent_budget` 失敗，resume 調高上限後沿用存檔、只補跑沒跑的。

Run: `npx vitest run src/parallelEngine.test.ts -t "agent_budget"`

Expected: 先 FAIL（現行是 `error` 或超賣），Step 6 完成後 PASS。

- [ ] **Step 7: 確認測試通過並完成 focused 驗證**

Run: `npx vitest run src/store.test.ts -t "reservation" && npx vitest run src/parallelEngine.test.ts -t "剩餘一格額度" && npx vitest run src/parallelEngine.test.ts`

Expected: PASS；新測試證明第二個呼叫沒有啟動，既有平行審查的存檔／quota 測試仍通過。

- [ ] **Step 8: Commit**

```bash
git add src/store.ts src/store.test.ts src/engine.ts src/parallelEngine.test.ts
git commit -m "平行流程：保留 agent 執行額度

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: 將車道基礎設施例外收束成失敗結果

**Files:**
- Modify: `src/lanes.ts:52-101`
- Modify: `src/lanes.test.ts`
- Modify: `src/engine.ts:1587-1612`（`driveLane` 的 `prepareLane` 納入 try）
- Test: `src/parallelEngine.test.ts`（`prepareLane` 失敗的整合案例）

**Interfaces:**
- `scheduleLanes()` 保持既有 `LaneResult` 公開介面；`hooks.start()`、`hooks.merge()`、`hooks.amend()` 的 rejection 一律轉成 `result.failed = { task, reason }`。
- 第一個失敗之後再發生的失敗原因（含例外）併入 `result.failed.reason`（以換行連接並標明 task id），不丟掉。
- `driveLane()` 的 `prepareLane()` 移進 try 內，其例外走同一條失敗路徑。
- 任何第一次失敗都令 `stopped = true`，但已啟動的 promise 繼續被消耗；其中成功完成者仍呼叫 `merge`，其失敗只在沒有既有失敗時成為 parent failure。

- [ ] **Step 1: 寫 `start()` rejection 的失敗測試**

在 `src/lanes.test.ts` 加兩個無相依任務：T-1 的 `start` 立即 `throw new Error("建立車道失敗")`；T-2 等待一個可控 promise 後回傳 `done`。呼叫 `scheduleLanes` 後斷言 T-2 已完成並呼叫 merge、沒有啟動依賴 T-1 的 T-3，且 `result.failed` 指向 T-1、reason 含錯誤訊息。這覆蓋「停止新派發但等待既有工作」的契約。

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run src/lanes.test.ts -t "start 例外"`

Expected: FAIL，rejection 穿透 `Promise.race()`。

- [ ] **Step 3: 將啟動 promise 正規化**

在 `launch()` 建立的 promise 鏈尾端加 `catch`，回傳原 task 搭配 `{ kind: "failed", reason: errorMessage(error) }`。新增僅供本檔使用的錯誤字串 helper，對 `Error` 取 `.message`，其他 thrown value 用 `String`，避免錯誤呈現本身再丟例外。

- [ ] **Step 4: 寫 `merge()` rejection 的失敗測試**

新增兩個同步啟動任務：T-1 的 merge throw `new Error("合併基礎設施失敗")`，T-2 的 merge 受控延遲後成功。斷言函式等待 T-2 merge 完畢才回傳、failure 指向 T-1，且下游任務不會啟動。此測試防止 await merge 直接中止排程迴圈、留下 T-2 背景 promise。

- [ ] **Step 5: 確認測試失敗**

Run: `npx vitest run src/lanes.test.ts -t "merge 例外"`

Expected: FAIL，`merge` rejection 直接由 `scheduleLanes` reject。

- [ ] **Step 6: 將 merge rejection 正規化並維持收束**

在 `outcome.kind === "done"` 分支以 `try/catch` 呼叫 `hooks.merge(task)`；catch 時設定 stopped 與第一個 `result.failed`，然後讓外層迴圈繼續處理 `running`。不要在 catch 中 return；只有 `running.size === 0` 才回傳。保留既有 redo、amend、paused 與合併失敗 object 的行為。

- [ ] **Step 6b: amend rejection、多重失敗與 prepareLane**

在 `src/lanes.test.ts` 加：（1）`amend` hook throw，斷言同樣等待其他車道收束、failure 指向請求者；（2）兩條車道同時拋不同例外，斷言 `result.failed.reason` 同時含兩個 task id 與兩段訊息。把 `amend` 的呼叫也包進 try/catch，catch 內設 stopped 並記下失敗，不 return。

在 `src/parallelEngine.test.ts` 加整合案例：讓其中一條車道的 worktree 建立失敗（例如預先放一個擋住路徑的檔案），斷言另一條車道仍跑完並合併，parent 以帶該 task id 的失敗收尾，且沒有 unhandled rejection。實作上把 `driveLane` 內的 `prepareLane` 移進 try，catch 沿用現有的失敗回報。

Run: `npx vitest run src/lanes.test.ts -t "amend 例外|多個失敗" && npx vitest run src/parallelEngine.test.ts -t "prepareLane"`

Expected: 先 FAIL 後 PASS。

- [ ] **Step 7: 執行 focused 驗證**

Run: `npx vitest run src/lanes.test.ts`

Expected: PASS，包含既有衝突重跑、amend、暫停與新 exception 收束案例。

- [ ] **Step 8: Commit**

```bash
git add src/lanes.ts src/lanes.test.ts src/engine.ts src/parallelEngine.test.ts
git commit -m "平行流程：收束車道基礎設施例外

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: replan 時重建人工確認快照

**Files:**
- Modify: `src/engine.ts:397-425`
- Modify: `src/engine.test.ts:1393-1447`

**Interfaces:**
- Produces `restoreHumanItems(run)`（`engine.ts` 內部函式）：把 `confirmations.json` 與 `confirmation-details.json` 的 confirm 任務、專屬驗收條件、計畫段落併回 `.flow/tasks.json`、`acceptance.json`、`plan.md`；已存在的 id 不重複加入，檔案不存在或無法解析時不動 `.flow/`。`replanRun` 在 `canReplan` 通過後、`validatePlan` 前呼叫。
- `separateHumanItems(run)` 每次成功讀到 `tasks.json` 與 `acceptance.json` 都覆寫：`confirmations.json` 為本次 `split.confirm`，`confirmation-details.json` 為 `{ acceptance: split.humanAcceptance, plan: split.humanPlan }`。
- 當沒有 confirm 任務時仍寫 `confirmations.json` 為 `[]`，並寫 `confirmation-details.json` 為 `{ acceptance: [], plan: {} }`。

- [ ] **Step 1: 寫 replan fixture 的失敗整合測試**

在 `engine.test.ts` 的 `replan：人工介入計畫` describe 中，先透過既有 `awaiting()`／`planSettledRun()` 建一個含 confirm 任務、專屬 acceptance 和 `## T-n` plan 段落的 run，驗證首次定案的兩份資料檔內容。接著將 `.flow/tasks.json`、`.flow/acceptance.json`、`.flow/plan.md` 換成新的 confirm 任務（可重用相同 id，但 title、描述、AC 與段落都不同），呼叫 `replanRun(run, { noReview: true })`，斷言兩份 run-dir JSON 只含新版項目，沒有舊 task、AC 或 plan 字串。

加入第二個情境：重新規劃後 tasks 沒有 confirm，斷言 `confirmations.json` 是空陣列且 `confirmation-details.json` 精確等於 `{ acceptance: [], plan: {} }`。這兩個測試分別保護陳舊資料移除與空資料檔契約。

再加兩個保留情境，這是本任務最重要的回歸測試：定案後 `replanRun(run, { note: "只改某個無關任務的措辭" })` 與 `replanRun(run, { noReview: true })`（沒有 note），斷言既有確認項目、驗收條件與計畫段落完整保留；以及 planner 在 `plan_fix` 後明確刪掉 `.flow/` 內被併回的 confirm 任務，斷言它從兩份資料檔消失。

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run src/engine.test.ts -t "replan.*人工確認"`

Expected: FAIL，舊的 merge 行為保留舊任務、舊驗收條件與舊 plan 段落，或沒有建立空的 detail 檔。（單做重建、沒做併回時，保留情境也會 FAIL：這正是兩步必須一起做的原因。）

- [ ] **Step 3a: 實作 `restoreHumanItems()` 並接進 `replanRun`**

它是 `splitHumanItems` 的反操作：任務併回 `tasks.json`、驗收條件併回 `acceptance.json`、計畫段落依原來的 `## T-n` 標題附加回 `plan.md`。confirm 任務原有的 `dependsOn` 不需處理（它們只被過濾、沒被改寫）。replan 失敗（`validatePlan` 不過）時丟錯、不改 run，但 `.flow/` 已被併回，這是預期的：使用者修的就是併回後的檔案。

- [ ] **Step 3: 簡化 `separateHumanItems()` 為重建而非合併**

移除 `loadConfirmations`／`loadConfirmationDetails` 的讀取和去重合併。只要 tasks 與 acceptance 可解析就先呼叫 `splitHumanItems`，無條件覆寫兩份 run-dir 檔案，再覆寫 `.flow/tasks.json`、`.flow/acceptance.json`、`.flow/plan.md` 和 `tasks.ordered.json`（仍需將 confirm dependencies 排除）。

若規劃檔無法解析，保留目前不破壞資料的行為；若解析成功但沒有 confirm，仍必須寫入上述空快照。確認只剩 `confirmationsPath` 的「不存在時寫 []」fallback 是否可刪除；detail 檔同樣必須由成功解析路徑保證存在。

- [ ] **Step 4: 執行 focused 驗證**

Run: `npx vitest run src/engine.test.ts -t "replan" && npx vitest run src/tasks.test.ts`

Expected: PASS，既有 replan workflow 與 `splitHumanItems` 的純函式契約未受影響。

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts src/engine.test.ts
git commit -m "重新規劃時重建人工確認資料

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: 全面回歸驗證與文件檢查

**Files:**
- Modify: `README.md`（僅在檢查確認可觀察行為需要說明時）

**Interfaces:**
- 不新增程式介面；驗證 Task 1–3 不影響既有順序任務、正常 lane 合併、replan 和 status 路徑。

- [ ] **Step 1: 檢視最終 diff 與 README 義務**

Run: `git diff --check && git diff -- README.md src/store.ts src/engine.ts src/lanes.ts`

Expected: 沒有 whitespace error；README 已依 Step 1b 補上額度行為說明（`agent_budget` 與失敗呼叫計入額度），確認該說明存在且措辭與實作一致。

- [ ] **Step 1b: 補 `mergeLane` 中斷的 resume 測試**

在 `src/parallelEngine.test.ts` 模擬合併成功後、`doneTasks` 存檔前中斷（例如 install 或 merge-test 命令丟例外）：resume 後重新合併只得到「已是最新」，該任務不被重做、不重複合併，最終 `doneTasks` 完整。

README 要加一句：`maxAgentRuns` 計入額度耗盡而失敗的呼叫，所以消耗得比成功呼叫數快；額度不足以 `agent_budget` 失敗，用 `resume --max-agent-runs` 調高。

- [ ] **Step 2: 執行完整驗證**

Run: `pnpm run typecheck && pnpm test && pnpm run build`

Expected: 全部 exit 0；任何既有失敗都要以檔名和錯誤內容記錄，不可將其歸為本變更通過。

- [ ] **Step 3: 最終 review 與交接**

依選定的執行方式完成獨立全分支 review，重點檢查 reservation 的 owner-id 共用與 finally 範圍、lane 例外是否遺留 promise、以及 replan 空確認資料。確認每項 spec 目標都有測試與實際證據後，才建立最終整合 commit。

## 自我審查

- Spec coverage：Task 1 實作額度 reservation 與同程序平行呼叫的上限；Task 2 實作 lane start／merge 例外收束；Task 3 重建 replan 的 confirmations 與 details；Task 4 驗證相容性與完整套件。
- Step scan：每項行為都先指定會失敗的觀察式測試，再指定最小實作與精確驗證命令；沒有用 source-text assertion 取代行為測試。
- Type consistency：reservation API 均以 string owner run id 與 number max 表達；lane 對外仍是既有 `LaneResult`／`LaneOutcome`；confirmation details 保持既有 `{ acceptance, plan }` 形狀。
- Review focus：五個高風險邊界各由 Task 1、Task 2 或 Task 3 的測試／最終 review 覆蓋，特別是同步 throw、owner id、存檔重用、非 Error throw、空資料檔。
- Proportion：計畫只固定介面、測試行為與必要的控制流程，未轉錄實作函式本體。
