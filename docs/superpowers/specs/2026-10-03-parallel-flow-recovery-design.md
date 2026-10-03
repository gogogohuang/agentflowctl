# 平行流程恢復與 replan 確認項目同步設計

## 目標

修正三個狀態機缺陷：平行車道不能超賣 agent 執行額度；任何車道基礎設施例外都不能留下未收束的背景工作；重新規劃後，PR 的人工確認項目必須與目前計畫一致。

既有的 `.flow/`、run state、用量 JSONL 與車道 worktree 格式維持相容；不改 CLI 選項與既有成功流程。

## 額度保留

新增 run 層級的執行額度 reservation。每個 `agentStep()` 在呼叫 CLI 前，先以 owner run id 原子保留一格；沒有可用額度時不啟動 CLI。無論 CLI 成功、失敗、額度耗盡或拋例外，都在 `finally` 釋放 reservation；已實際啟動的呼叫仍由既有 usage JSONL 記為一次執行。

可用額度的判斷為「已寫入 usage 的次數 + 目前 reservation 數 < maxAgentRuns」。這讓同一程序的平行審查與平行車道共享同一上限，並維持 resume 時由 usage JSONL 恢復已使用額度的語意。reservation 只存在於程序記憶體；程序中斷時不需清理，下一次啟動會依持久化 usage 重新計算。

## 車道例外收束

`scheduleLanes()` 不再讓 `start()` 或 `merge()` 的 rejection 穿透 `Promise.race()`。每條車道的例外轉為帶有 task 與錯誤訊息的 `failed` outcome。

首次失敗後排程停止開新車道，但會收集所有既有 promise 的結果。已完成的車道仍沿用現有合併與重做規則；失敗或尚未完成的車道狀態會保留在其 lane state，供 `resume` 從同一個位置恢復。排程只在所有已啟動 promise 都收束後回傳 parent failure，避免 terminal parent state 與仍在執行的子流程並存。

## replan 的人工確認資料

`separateHumanItems()` 改為由當前 `tasks.json`、`acceptance.json` 與 `plan.md` 重建 `confirmations.json` 和 `confirmation-details.json`，而非與舊資料合併。首次定案與 replan 都走同一條重建路徑。

因此 replan 刪除 confirm 任務時，PR checklist 會移除它；同 ID 的任務、驗收條件或計畫段落改寫時，PR 會顯示新內容。沒有 confirm 任務時，兩份資料檔仍存在且為空資料，讓 status 與 PR 產生流程保持可預期。

## 測試

- 以多個同步啟動的車道驗證：剩餘一格額度時只會啟動一個 agent。
- 以會 throw 的車道建立與合併 hook 驗證：排程等待既有工作收束、停止派發，並把例外報成帶 task 的 failure。
- 以先定案、再修改 confirm 任務的 replan fixture 驗證：確認檔和詳細資料會移除陳舊項目並採用新內容。

既有的單一車道、正常合併、順序 replan 與 status 輸出測試必須維持通過。
