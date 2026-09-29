# 可指定流程停點 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓每次 run 可指定公開流程階段，在產出完成後暫停並可用 `resume` 接續，且同步更新 README。

**Architecture:** 在 `FlowRun` 保存 optional 的 `stopAfter`，由 engine 在每次 stage 成功返回下一階段後集中判斷是否抵達停點；停點使用既有 `paused` 狀態，`pausedStage` 保存下一個 active stage。CLI 只在建立 run 時接受停點並驗證，報告層顯示指定停點與停止原因，沒有停點的舊 run 維持原行為。

**Tech Stack:** Node.js 22、TypeScript、Zod、Commander、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-29-stop-after-stage-design.md`

## Global Constraints

- 公開停點只接受 `spec`、`plan`、`implement`、`verify`、`review`、`pr`。
- `plan_review`、`plan_fix`、`fix` 不接受為停點。
- `pr` 照常完成並進入 `done`；其他停點完成後進入 `paused`。
- `FlowRun.stopAfter` 必須 optional，舊 `state.json` 沒有欄位時仍可讀。
- `--manual-plan` 與 `--stop-after` 同時使用時，在建立 worktree 前報錯。
- 每一次使用者可見行為變更都要同步更新 `README.md`。
- 程式碼、測試、prompt、commit 訊息與使用者看到的輸出使用繁體中文。

## Review Focus

- 停在 `spec` 後不能多跑一次 `plan`，且 resume 要從 `plan` 開始。
- 停在 `plan` 必須是計畫審查完成後，不得停在 `plan_review` 或 `awaiting_approval`。
- 停在 `implement`、`verify`、`review` 時要攔截正確的下一階段，不能因 stage 名稱與 taskPhase 混淆而提早停止。
- `stopAfter: "pr"` 不應進入 paused 或卡住，而是讓既有 PR stage 完成並進入 done。
- 沒有 `stopAfter` 的舊 run、額度 paused run、失敗後 resume 都要維持既有語意。

### Task 1: 增加停點型別與 engine 邊界判斷

**Files:**
- Modify: `src/schemas.ts` 的 `Stage`／`FlowRun`
- Modify: `src/engine.ts` 的 `ActiveStage`、`advance()` 與 stage transition 邏輯
- Test: `src/schemas.test.ts`
- Test: `src/engine.test.ts`

**Interfaces:**
- Produces: `FlowRun.stopAfter?: StopAfterStage`，以及 engine 內部公開的 `StopAfterStage`／停點順序判斷；`advance()` 仍回傳 `Promise<FlowRun>`。

- [ ] **Step 1: Write the failing schema tests**

  在 `src/schemas.test.ts` 增加測試：含 `stopAfter: "verify"` 的 run 可解析；省略 `stopAfter` 的舊 run 可解析；`stopAfter: "plan_review"` 與未知字串拒絕。

- [ ] **Step 2: Run schema tests to verify they fail**

  Run: `npx vitest run src/schemas.test.ts`
  Expected: FAIL，因 `FlowRun` 尚未接受 `stopAfter`。

- [ ] **Step 3: Implement `StopAfterStage` and optional `FlowRun.stopAfter` in `src/schemas.ts`**

  新增只包含六個公開值的 Zod enum 與 TypeScript type，並把 `stopAfter` 設為 optional；不要把內部 stage 放進 enum。

- [ ] **Step 4: Run schema tests to verify they pass**

  Run: `npx vitest run src/schemas.test.ts`
  Expected: PASS。

- [ ] **Step 5: Write failing engine boundary tests**

  在 `src/engine.test.ts` 覆蓋 `spec`、`plan`、`implement`、`verify`、`review` 的結果：指定停點時結果為 `paused`、`pauseReason` 表示指定階段已完成、`pausedStage` 是正確下一階段；另測沒有停點仍為 `done`，以及 `stopAfter: "pr"` 仍完成 `done`。測試使用既有 engine fixture／mock，不呼叫真實 agent。

- [ ] **Step 6: Run engine tests to verify they fail**

  Run: `npx vitest run src/engine.test.ts`
  Expected: FAIL，因 advance 尚未攔截公開停點。

- [ ] **Step 7: Implement centralized stop-after handling in `src/engine.ts`**

  新增公開停點順序與 `stopAfter` 判斷 helper；在 `advance()` 將 stage handler 的結果存回前，辨識本輪完成的公開 stage。目標不是 `pr` 且剛完成目標時，回傳 `stage: "paused"`、`pausedStage: next.stage`、`pauseReason` 為繁體中文完成訊息；清除舊的 quota pause 欄位。沒有目標或目標為 `pr` 時沿用既有流程。不要依賴 agent 回覆判斷完成。

- [ ] **Step 8: Run engine tests to verify they pass**

  Run: `npx vitest run src/engine.test.ts`
  Expected: PASS。

- [ ] **Step 9: Commit Task 1**

  ```bash
  git add src/schemas.ts src/schemas.test.ts src/engine.ts src/engine.test.ts
  git commit -m "feat: 支援流程停點狀態"
  ```

### Task 2: CLI 建立 run 的選項與錯誤驗證

**Files:**
- Modify: `src/cli.ts` 的 `run` option、action 型別與 `saveRun` payload
- Test: `src/cli.model.test.ts` 或新增 `src/cli.test.ts`（依現有 CLI 測試工具可測範圍）

**Interfaces:**
- Consumes: Task 1 的 `StopAfterStage` 與 `FlowRun.stopAfter`。
- Produces: `run --stop-after <stage>` 將值寫入新 run；`--manual-plan` 同時指定時在 `addWorktree` 前丟出繁體中文錯誤。

- [ ] **Step 1: Write failing CLI validation tests**

  增加可測的純函式或 CLI action 測試，固定驗證：六個公開值接受；`plan_review` 與未知值拒絕；`--manual-plan --stop-after plan` 拒絕；建立 run 的 payload 保存 `stopAfter`。若現有 CLI 沒有可注入 action 的測試 seam，先抽出 `parseStopAfter(value?: string): StopAfterStage | undefined` 與 `validateRunOptions(...)` 純函式再測。

- [ ] **Step 2: Run the focused CLI tests to verify they fail**

  Run: `npx vitest run src/cli.model.test.ts`（若新增檔案則改跑該檔案）
  Expected: FAIL，因尚未有停點解析與互斥驗證。

- [ ] **Step 3: Implement CLI parsing and run persistence in `src/cli.ts`**

  新增 `--stop-after <stage>` option；使用 schema enum safeParse 轉換並以明確錯誤列出可用值；在計算 base、resolve cycle、建立 worktree 前完成 option validation；將解析值寫入 `saveRun`。`resume` 不新增改停點選項。

- [ ] **Step 4: Run focused CLI tests to verify they pass**

  Run: `npx vitest run src/cli.model.test.ts`（或新增 CLI 測試檔）
  Expected: PASS。

- [ ] **Step 5: Commit Task 2**

  ```bash
  git add src/cli.ts src/cli.model.test.ts src/cli.test.ts
  git commit -m "feat: 讓 run 指定流程停點"
  ```

### Task 3: Resume 與停止報告顯示停點語意

**Files:**
- Modify: `src/cli.ts` 的 `resume`／`printSummary`
- Modify: `src/stopReport.ts`
- Test: `src/stopReport.test.ts`
- Test: `src/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FlowRun.stopAfter`、`pausedStage`、`pauseReason`。
- Produces: resume 保留 `stopAfter` 並清除一次性 pause 欄位；summary／stop report 顯示指定停點完成與下一階段。

- [ ] **Step 1: Write failing report and resume tests**

  在 `src/stopReport.test.ts` 測試刻意停下時輸出指定階段與 `agentflowctl resume <id>`；在 engine／CLI 相關測試確認 resume 後 stopAfter 仍存在，完成下一個目標前不會被清掉。

- [ ] **Step 2: Run focused tests to verify they fail**

  Run: `npx vitest run src/stopReport.test.ts src/engine.test.ts`
  Expected: FAIL，因現有報告只把 paused 視為額度暫停，且 resume 行為未覆蓋新欄位。

- [ ] **Step 3: Implement report and resume behavior**

  在 `printSummary` 顯示 stopAfter；`stopReport` 依 `pauseReason` 或明確的停止訊息顯示「已完成指定階段」與下一步 resume。resume 只清除 quota pause 的一次性欄位，不移除 stopAfter；既有 quota paused／failed 行為保持原樣。

- [ ] **Step 4: Run focused tests to verify they pass**

  Run: `npx vitest run src/stopReport.test.ts src/engine.test.ts`
  Expected: PASS。

- [ ] **Step 5: Commit Task 3**

  ```bash
  git add src/cli.ts src/stopReport.ts src/stopReport.test.ts src/engine.test.ts
  git commit -m "feat: 顯示流程停點與續接資訊"
  ```

### Task 4: README 與整體驗證

**Files:**
- Modify: `README.md` 的使用方式、選項表、故障／續接說明
- Test: `src/schemas.test.ts`, `src/engine.test.ts`, `src/stopReport.test.ts`（回歸測試）

**Interfaces:**
- Consumes: Task 1–3 的 CLI、狀態與報告行為。
- Produces: 使用者可依 README 執行 `run --stop-after`、檢視產出並用 `resume` 接續。

- [ ] **Step 1: Write README behavior examples and update documentation**

  在 README 加入 `--stop-after` 選項、六個停點的產出語意、範例命令、`paused` 後的 `resume` 流程，並說明 `--manual-plan` 互斥；更新流程描述與狀態處理表。

- [ ] **Step 2: Run formatting and full verification**

  Run: `git diff --check`
  Expected: PASS。

  Run: `pnpm run typecheck`
  Expected: PASS。

  Run: `pnpm test`
  Expected: PASS。

- [ ] **Step 3: Commit Task 4**

  ```bash
  git add README.md
  git commit -m "docs: 說明可指定流程停點"
  ```

## Plan Self-Review

- Spec coverage: Task 1 covers schema、stage boundary、相容性；Task 2 covers CLI、互斥與建立前驗證；Task 3 covers resume、status／stop report；Task 4 covers README 與完整驗證。
- Step scan: 每個 task 都先寫 failing test，再實作與驗證；每個 implementation step 指定檔案、型別／行為與保留的既有語意。
- Type consistency: `StopAfterStage` 與 `FlowRun.stopAfter` 由 Task 1 產出，Task 2／3 只消費同一欄位；`pausedStage` 仍使用既有 `Stage`。
- Review Focus coverage: spec、plan、implement、verify、review 邊界由 Task 1 測試；pr、舊 run、quota／failed resume 由 Task 1／3 測試；CLI 輸入由 Task 2 測試。
- Proportion: 計畫只列出必要的測試名稱、介面與驗證命令，沒有預寫實作內容。
