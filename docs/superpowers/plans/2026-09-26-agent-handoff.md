# Agent 交接紀錄 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓跨階段待處理事項有持久化紀錄、可追蹤結案，並在計畫定案和開 PR 前阻止未處理的事項被遺漏。

**Architecture:** Agent 每一步產出 `.flow/handoff-response.json`，程式驗證後合併至 run 外的 `handoff.json`；每次呼叫前由正式紀錄產生 `.flow/handoff-context.md`。`engine.ts` 在既有關卡驗證成功後接收交接回覆，並在計畫與程式碼審查通關前檢查未結事項。XML `<result>` 維持僅供人看。

**Tech Stack:** Node.js >=22、TypeScript、zod、Vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-09-26-agent-handoff-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者可見輸出使用繁體中文。
- 使用者可見行為變更須在同一個 commit 更新 `README.md`。
- 新增 `FlowRun` 欄位必須 optional；優先讓交接紀錄獨立於 `state.json`。
- 關卡依檔案、git diff、測試與經驗證的 JSON 判斷；XML `blocked` 不單獨決定轉移。
- `.flow/` 是 agent 可讀寫的暫存區；正式紀錄由程式寫在 `.agentflowctl/runs/<id>/`。

## Review Focus

- 舊 run 沒有 `handoff.json`：讀取為空紀錄，resume 的新步驟開始要求交接回覆。
- 成功 agent 沒寫交接回覆或寫了非法 JSON：不能當作無事項，依該步驟重試。
- 同一步驟在合併後、狀態存檔前中斷：resume 不重複產生事項，也不遺失已驗證回覆。
- 審查 JSON 核准但交接回覆新增 `action`：不能進入下一關，要求同一審查步驟重試。
- 匿名仲裁讀取交接上下文：不可含作者、審查者或來源 agent 名稱。

---

### Task 1: 交接資料模型與持久化

**Files:**
- Modify: `src/schemas.ts`
- Create: `src/handoff.ts`
- Create: `src/handoff.test.ts`
- Modify: `src/paths.ts`

**Interfaces:**
- `HandoffResponse`：`{ newIssues: { kind, summary, evidence, targetStage }[], dispositions: { id, status, reason, evidence }[] }`；`kind` 為 `action | info`、`targetStage` 為 `plan | code`、`status` 為 `proposed_resolved | resolved | accepted`；兩個陣列都必填，允許空陣列。
- `HandoffSource`：`{ stage: Stage, step: string, agent: string, callKey: string }`。
- `HandoffLedger`：`{ version: 1, issues: HandoffIssue[] }`；事項含 `id`、`source`、`kind`、`summary`、`evidence`、`targetStage`、`status`（另含 `open`）、可選 `resolution`、`updatedAt`。
- `readHandoff(id: string): HandoffLedger`：檔案不存在時回空 v1 紀錄；存在但格式錯誤時丟錯。
- `mergeHandoff(id: string, callKey: string, source: HandoffSource, response: HandoffResponse, role: "writer" | "reviewer"): HandoffLedger`：驗證 ID、處置權限與證據，依 `callKey` 冪等合併並原子寫入。
- `previewHandoff(ledger: HandoffLedger, callKey: string, source: HandoffSource, response: HandoffResponse, role: "writer" | "reviewer"): HandoffLedger`：純函式，供關卡在寫檔前檢查合併結果。
- `openActions(ledger: HandoffLedger, target?: "plan" | "code"): HandoffIssue[]`：回傳 `open`、`proposed_resolved` 的 `action`。
- `handoffPath(id: string): string`：正式紀錄路徑。

- [ ] **Step 1: Write failing tests** — `src/handoff.test.ts` 驗證空舊紀錄、空回覆、穩定 ID、重複合併、不同呼叫 key、多來源同問題不自動合併、作者只能提出 `proposed_resolved`、reviewer 以證據結案、非法 ID／無理由結案拒絕、無效正式紀錄不被覆寫。
- [ ] **Step 2: Run red test** — `npx vitest run src/handoff.test.ts`，預期因介面不存在而失敗。
- [ ] **Step 3: Implement schemas and ledger functions** — 以 `writeFileSync(tmp)` 加 `renameSync` 原子替換；事項 ID 由 `callKey` 與項目序號產生，不使用隨機值；同一 `callKey` 重播應回傳原結果。先用 `previewHandoff` 驗證合併，再持久化。
- [ ] **Step 4: Run green test** — `npx vitest run src/handoff.test.ts`，預期全部通過。
- [ ] **Step 5: Commit** — `git add src/schemas.ts src/handoff.ts src/handoff.test.ts src/paths.ts`；`git commit -m "feat: 建立交接事項模型與持久化紀錄"`。

### Task 2: Agent 呼叫的交接輸入、輸出與中斷恢復

**Files:**
- Modify: `src/handoff.ts`
- Modify: `src/handoff.test.ts`
- Modify: `src/engine.ts`
- Modify: `src/paths.ts`
- Modify: `prompts/*.md`（9 個既有階段 prompt）
- Modify: `src/prompts.test.ts`
- Modify: `README.md`

**Interfaces:**
- `prepareHandoff(runId: string, callKey: string, target: "plan" | "code", blind: boolean): void`：從正式紀錄產生上下文，刪除前一呼叫的回覆檔；`blind` 時移除來源身分。
- `validateHandoffResponse(runId: string): JsonResult<HandoffResponse>`：檔案缺失或無效時回錯誤，不以 `[]` 代替。
- `acceptHandoff(runId: string, callKey: string, source: HandoffSource, response: HandoffResponse, role: "writer" | "reviewer"): void`：先寫已驗證收據、冪等合併，再標記收據完成。
- `recoverHandoff(runId: string): void`：`advance()` 開始時重播未完成的已驗證收據，不能重播失敗 agent 的暫存輸出。
- `StepMode` 加 `handoffKey`、`handoffTarget`、`blind`；每位 panel 成員使用含輪次與位置的不同 key。

- [ ] **Step 1: Write failing tests** — 測試上下文只含相關未結事項、匿名輸出不含任何來源 agent、無效／缺失回覆、額度代打前舊回覆已清掉、已驗證收據在中斷後可冪等重播；`src/prompts.test.ts` 逐份檢查交接輸入與輸出指示、空清單範例、審查檔案允許清單。
- [ ] **Step 2: Run red test** — `npx vitest run src/handoff.test.ts src/prompts.test.ts`，預期新測試失敗。
- [ ] **Step 3: Implement preparation and recovery** — 在 `agentStep()` 呼叫前準備上下文；回覆先驗證但只在原有階段檢查成功後接收。失敗與 quota reset 時刪除回覆檔，不動正式紀錄。同步更新全部 prompt 與 README 的交接規則；將只寫 `<concerns>` 的測試疑慮改為寫交接回覆。
- [ ] **Step 4: Run green test and typecheck** — `npx vitest run src/handoff.test.ts src/prompts.test.ts`、`pnpm run typecheck`，預期通過。
- [ ] **Step 5: Commit** — `git add src/handoff.ts src/handoff.test.ts src/engine.ts src/paths.ts prompts src/prompts.test.ts README.md`；`git commit -m "feat: 在 agent 步驟保存並傳遞交接事項"`。

### Task 3: 每個階段的交接關卡與結案

**Files:**
- Modify: `src/engine.ts`
- Create: `src/engine.test.ts`
- Modify: `src/handoff.ts`
- Modify: `src/handoff.test.ts`
- Modify: `README.md`

**Interfaces:**
- `acceptStageHandoff(run: FlowRun, callKey: string, agent: string, role: "writer" | "reviewer", gate?: "plan" | "code"): JsonResult<HandoffLedger>`：讀回覆、驗證、預覽合併；若審查 verdict 為 `approve`，先通過 `gate` 的未結事項檢查，再寫正式紀錄。
- `reviewHandoffGate(ledger: HandoffLedger, gate: "plan" | "code", verdict: "approve" | "changes_requested"): string | undefined`：`approve` 與新建或未結 `action` 矛盾時回繁體中文錯誤；`changes_requested` 仍走原有修正流程。

- [ ] **Step 1: Write failing tests** — 用 command adapter 或可注入的 agent 執行器，驗證 spec／plan／測試／實作／fix 的成功步驟都需回覆；驗證原有關卡失敗時不合併；plan_review、仲裁、review 的 approve 與未結 `action` 矛盾時重試；全部審查通過且無未結事項才進 `pr`；多位 reviewer 的事項分別保存。
- [ ] **Step 2: Run red test** — `npx vitest run src/engine.test.ts src/handoff.test.ts`，預期新測試失敗。
- [ ] **Step 3: Implement stage integration** — 在各階段原有程式檢查成功後接受交接回覆；維持現有 `retry()` 次數、`QuotaPause`、`fix` 選人與 review quorum 行為。審查結果 JSON 與交接回覆不一致時，依該審查步驟重試。同時更新 README 的計畫／程式碼審查通關條件。
- [ ] **Step 4: Run green test** — `npx vitest run src/engine.test.ts src/handoff.test.ts`，預期全部通過。
- [ ] **Step 5: Commit** — `git add src/engine.ts src/engine.test.ts src/handoff.ts src/handoff.test.ts README.md`；`git commit -m "feat: 以交接紀錄把關計畫與程式碼審查"`。

### Final verification

- [ ] 執行 `pnpm run typecheck`、`pnpm test`、`pnpm run build`，確認全部通過。
- [ ] 執行 `git diff --check` 與 `git status --short`，確認無遺漏檔案與格式錯誤。
- [ ] 對照規格的每個邊界條件與測試名稱；若實作導致規格決策改變，在同一分支更新設計文件並提交。
