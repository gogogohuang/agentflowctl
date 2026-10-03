# 平行流程恢復與 replan 確認項目同步設計

## 目標

修正三個狀態機缺陷：平行車道不能超賣 agent 執行額度；任何車道基礎設施例外都不能留下未收束的背景工作；重新規劃後，PR 的人工確認項目必須與目前計畫一致，而且不能因為重新規劃就遺失 planner 看不到的既有確認項目。

既有的 `.flow/`、run state、用量 JSONL 與車道 worktree 格式維持相容；不改 CLI 選項與既有成功流程。

## 額度保留

新增 run 層級的執行額度 reservation。每個 `agentStep()` 在呼叫 CLI 前，先以 owner run id 原子保留一格；沒有可用額度時不啟動 CLI。無論 CLI 成功、失敗、額度耗盡或拋例外，都在 `finally` 釋放 reservation；已實際啟動的呼叫仍由既有 usage JSONL 記為一次執行（含額度耗盡的呼叫，所以 `maxAgentRuns` 會比成功呼叫數消耗得快，README 要說明）。

可用額度的判斷為「已寫入 usage 的次數 + 目前 reservation 數 < maxAgentRuns」。這讓同一程序的平行審查與平行車道共享同一上限，並維持 resume 時由 usage JSONL 恢復已使用額度的語意。reservation 只存在於程序記憶體；程序中斷時不需清理，下一次啟動會依持久化 usage 重新計算。

### 額度不足的處理

保留失敗時丟出專用的 `AgentBudgetError`（不是 `QuotaPause`：額度暫停是等 agent 恢復，這裡是 `maxAgentRuns` 用完，使用者要 `resume --max-agent-runs` 調高）。各層一律映射成 `agent_budget` 失敗，並保留既有的調高上限提示：

- `advance()`：catch 到 `AgentBudgetError` 時存成 `failureCategory: "agent_budget"`，不落入一般的 `error`。
- `driveLane()`：車道回報 `{ kind: "failed", category: "agent_budget" }`。
- 平行審查：個別 worker 的 `AgentBudgetError` 先收下，已開始的審查照常跑完並存檔，全部結束後才丟出，語意與既有的「最後才丟 QuotaPause」一致。

移除 `driveLane()` 與 `executeReviewCalls()` 各自的預先額度檢查（一個 `implementStage` 內有多次 agent 呼叫，預先檢查本來就會超賣），改由 reservation 單一機制把關。

## 車道例外收束

`scheduleLanes()` 不再讓 `start()`、`merge()` 或 `amend()` 的 rejection 穿透 `Promise.race()` 或中斷排程迴圈。三者的例外都轉為帶有 task 與錯誤訊息的 `failed` outcome。`driveLane()` 內位於 try 之外的 `prepareLane()`（git worktree 操作）是 `start` rejection 的主要來源，同樣納入收束。

首次失敗後排程停止開新車道，但會收集所有既有 promise 的結果。已完成的車道仍沿用現有合併與重做規則；失敗或尚未完成的車道狀態會保留在其 lane state，供 `resume` 從同一個位置恢復。排程只在所有已啟動 promise 都收束後回傳 parent failure，避免 terminal parent state 與仍在執行的子流程並存。

`result.failed` 仍只代表第一個失敗；之後同時發生的其他失敗原因（含例外）併入同一個 failure 訊息，不再被 `??=` 丟掉。非 `Error` 的 thrown value 以 `String` 轉成訊息。

## replan 的人工確認資料

定案後 confirm 任務、專屬驗收條件與計畫段落已從 `.flow/` 搬走，planner 看不到它們。因此不能單純「從當前 `.flow/` 重建」：那會在只加備註或 `--no-review` 的 replan 後清空所有既有確認項目。

做法分兩步，首次定案與 replan 都走同一條路徑：

1. **併回。** `replanRun` 通過 `canReplan` 後、`validatePlan` 之前，把 `confirmations.json` 與 `confirmation-details.json` 的內容反向併回 `.flow/tasks.json`、`acceptance.json`、`plan.md`（`splitHumanItems` 的反操作，已存在於當前檔案的 id 不重複加入），讓 planner 與使用者手改都看得到這些項目，也才能真的刪除或改寫它們。
2. **重建。** `separateHumanItems()` 由當前 `tasks.json`、`acceptance.json` 與 `plan.md` 重建 `confirmations.json` 和 `confirmation-details.json`，覆寫而非與舊資料合併。

因此 replan 刪除 confirm 任務時，PR checklist 會移除它；同 ID 的任務、驗收條件或計畫段落改寫時，PR 會顯示新內容；未被動過的項目保持不變。沒有 confirm 任務時，兩份資料檔仍存在且為空資料（`[]` 與 `{ "acceptance": [], "plan": {} }`），讓 status 與 PR 產生流程保持可預期。

併回只發生在 replan：`canReplan` 限定計畫階段，此時還沒有實作期間才會寫入的 `rememberConfirmation` 項目，所以重建不會丟掉它們。

## 測試

- 以多個同步啟動的車道驗證：剩餘一格額度時只會啟動一個 agent；額度不足時 run 以 `agent_budget` 失敗，不是 `error`，也不是暫停。
- 平行審查中一位遇到額度不足時，其餘已開始的審查跑完並存檔，最後才失敗。
- 以會 throw 的車道建立（`prepareLane`）、合併與 `amend` hook 驗證：排程等待既有工作收束、停止派發，並把例外報成帶 task 的 failure；同時有多個失敗時，原因都出現在訊息中。
- 以先定案、再修改 confirm 任務的 replan fixture 驗證：確認檔和詳細資料會移除陳舊項目並採用新內容。
- 以定案後只加備註（以及 `--no-review`）的 replan 驗證：既有確認項目、驗收條件與計畫段落完整保留。
- 補一個 `mergeLane` 在合併成功後、`doneTasks` 存檔前中斷的 resume 測試：重新合併只得到「已是最新」，任務不會被重做或重複合併。

既有的單一車道、正常合併、順序 replan 與 status 輸出測試必須維持通過。
