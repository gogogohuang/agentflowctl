# 修補任務（amend）設計

## 目標

實作階段中，後面的任務發現必須改變已合併的前面任務的行為時，可以提出「修正請求」，由引擎插入一個依賴該任務的修補任務，走完整的紅燈 → 綠燈 → 任務審查 → 任務驗證，合併後請求者再從最新分支重做。不改寫已合併的歷史，也不原地重開已完成的任務。

## 不做的事

- 不原地改寫已合併的 commit（會破壞 `doneTasks`、審查紀錄與車道基底）。
- 不重開舊任務（attempts、審查輪次、`testsCommit` 都得重置，語意混亂）。
- 不讓 agent 判斷請求是否合理。合理性交給修補任務之後的任務審查。

## 流程與資料

### 1. 請求出口

寫檔類階段的 agent 可寫 `.flow/amend-request.json`：

```json
{ "target": "T-1", "reason": "…", "files": ["src/a.ts"], "acceptance": ["修補後應成立的可驗證條件"] }
```

`schemas.ts` 新增 `AmendRequest`（zod）。

### 2. 程式檢查

只看程式能驗證的事實：

- 格式通過 `AmendRequest`。
- `target` 在已合併集合（`doneSet`）內，且不是請求者自己，也不是尚在進行的修補任務。
- 該 target 已被修補的次數小於 `maxAmendments`（`flow.config.json`，預設 2）。
- 套用時預算加碼：`maxAgentRuns` 加上 `agentRunsPerTask`（run／resume 明確指定過上限、即 `maxAgentRunsExplicit` 為真時不加）。

不通過時用 `retry()` 把原因寫進 `feedback.md`，請求者重寫；連續超過 `maxAttempts` 照舊讓 run 失敗。達到修補上限則丟既有的 `QuotaPause`，訊息說明被修補的任務與下一步，run 暫停；暫停原因本身就帶有請求者、被修補的任務與次數／上限，不新增 `stopReport` 輸出。下一步是檢查 `.flow/feedback.md`（車道模式為該車道的 feedback）後 `resume`；停在 implement 階段無法 `replan`。

### 3. 插入修補任務

產生 `TaskItem`：`id` 為下一個編號 `T-<最大編號+1>`（`TaskItem.id` 規則為 `^T-\d+$`）、`kind` 為 `amend`（`TaskItem.kind` 新增此值）、新增 `amendOf` 欄位記 target、`dependsOn: [target]`。驗收條件：請求的 `acceptance` 文字由引擎追加到 `acceptance.json` 成為新的 AC 項目（相同描述重用既有 id），任務的 `acceptance` 寫這些 AC id。寫入 `.flow/tasks.ordered.json`，並把請求者的 `dependsOn` 加上修補任務。`tasks.json` 不動；修補次數記在 `FlowRun.amendments`。

`tasks.ordered.json` 已在 `LOCKED_FILES`，agent 直接改仍會被還原，只有引擎的插入路徑能改。

### 4. 執行

修補任務是普通任務，走既有的任務階段，不另寫流程。因為它依賴已合併的 target，`readyTasks` 會立刻視為就緒。

- 平行模式：請求者的車道丟棄（`resetTo` 回合併前的 HEAD，沿用 `mergeLane` 的 `redoLane` 做法），修補任務開新車道，合併後請求者從新 HEAD 重做。其他不相關車道照常，衝突靠現有的衝突重做。
- 順序模式：修補任務插在請求者之前，請求者的 `taskIndex` 往後移一格並重置為 `tests` 階段。

### 5. 狀態欄位

`FlowRun.amendments`（optional，記每個 target 的次數），讓舊的 `state.json` 仍可讀入。

## 錯誤與邊界

- 請求無效：`retry()` 寫進 `feedback.md`。
- 達修補上限：丟既有的 `QuotaPause`。
- 修補任務自己失敗：沿用既有的任務失敗流程。
- 修補任務又提出請求：可指向更早的任務，不可指向修補中的任務本身（避免環）。
- 中斷與 resume：順序固定為「改 `tasks.ordered.json` → 記 `FlowRun.amendments` → 重置請求者車道」；以「kind 為 amend、amendOf 與 description 都相同的任務是否已存在」判斷是否已套用，任一步之後中斷都不會重複插入。

## 測試（vitest，與原始碼同目錄）

- `schemas.test.ts`：`AmendRequest` 驗證；沒有 `amendments` 的舊 `state.json` 可讀入。
- `amend.test.ts`：`decideAmend` 的各種判斷。
- `lanes.test.ts`：插入修補任務後 `readyTasks` 讓它先就緒，請求者被擋到它合併之後。
- engine 層：請求被接受、各種拒絕原因、達上限暫停、冪等 resume；用真的 git repo 驗證請求者車道重置。
- `roles.test.ts`：修補任務的作者與審查者輪替和順序執行一致（`taskPosition`）。
- prompt：新增變數時補測試，少變數會丟錯。

## Prompt 與文件

寫檔類 prompt 加一段 `<amend>`，說明何時該提出請求（需要改變已合併任務的行為，而不是自己實作不足），回覆附 `<result>`；同步改 engine 內對應的 `renderPrompt` 呼叫。README 補上 `maxAmendments`、新暫停狀態與修補任務的行為。
