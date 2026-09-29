# 審查者平行（子專案 1／3）

平行化分三個子專案依序做：**1. 審查者平行（本文件）** → 2. 多個 run 同時跑 → 3. 任務平行。這一份只處理審查者，但「每個工作單位一個隔離 worktree」與「完成即存檔、可重播」這兩個機制要能被後兩個子專案重用。

## 目標與硬性要求

- 一組審查者（`planReviewFull`、`planReviewLayered` 的索引與各群、`codeReview`）同時執行，縮短一輪審查的時間。
- **任何時刻都能停下（Ctrl-C、SIGTERM、當機）並用 `resume` 接續**：不留下會擋住下次執行的殘骸，已付費完成的審查不重跑，重播後的結果與不中斷時一致。
- 額度用完時，其他審查者照常跑完並存檔，全部結束後才暫停。
- 預設開啟，`flow.config.json` 的 `reviewConcurrency` 設上限（正整數，預設不限，`1` 等同現在的序列行為）。

不在範圍：寫檔類步驟（作者、修正者）、跨 run 並行、任務並行。

## 現況與衝突點

- 審查者共用同一個 worktree：輸出檔（`plan-review.json`、`review.json`）、交接檔（`.flow/handoff-response.json`，`prepareHandoff` 會先刪掉）、事後的 `discardChanges` 與 `restorePlan` 都是整個 worktree 層級，直接 `Promise.all` 會互相覆蓋。
- 交接帳本（`mergeHandoff`）與 `run` 狀態更新（`retry`、`recordModelReviewFailure`）是讀改寫，不能並行。
- `nextLogFile` 用「目錄最大序號 + 1」，兩個呼叫同時取號可能撞號。
- `cli.ts` 收到 SIGINT 直接 `process.exit(130)`，`finally` 不會跑。
- 整組審查被中斷時，目前已完成的審查會整輪重跑（只有 `planReviewLayered` 有進度檔）。

## 設計

### 1. 每個呼叫一個臨時 worktree

- 位置：`.agentflowctl/runs/<id>/tmp-review/<呼叫識別>/`（`.agentflowctl/` 已在 exclude 內）。
- 建立：`git worktree add --detach <dir> HEAD`，再把 run 的 `.flow/` 複製進去。不帶 `node_modules`，審查不跑專案指令。
- 審查者在臨時 worktree 內工作，輸出檔與交接回覆都寫在它自己的 `.flow/`。
- 結束（成功、失敗、額度用完）後：先把結果存到 run 目錄（見 §3），再 `git worktree remove --force` 並刪目錄。審查者亂改檔案的還原就是刪除，不再對共用 worktree 做 `discardChanges`／`restorePlan`。
- 額度用完的重試沿用 `agentStep` 的迴圈，重試前 `reset` 改成重建臨時 worktree。

### 2. 執行器：`src/parallelReview.ts`

`runParallel(run, specs, limit)`：

- semaphore 限制同時執行數為 `min(reviewConcurrency, 剩餘 agent 預算)`。啟動前以 `agentRuns(run.id)` 對照 `maxAgentRuns`，不讓平行啟動超出預算；預算不足的呼叫不啟動，交回給序列階段處理。
- 平行階段**只跑 agent、收結果**，不寫 `state.json`、不動帳本、不呼叫 `retry`。
- 每個呼叫回傳：成功的原始輸出（審查 JSON、交接回覆、`agent`／`step`／`callKey`）、失敗原因，或「額度用完」。
- 額度用完：記進 `exhausted`，其他呼叫繼續，全部結束後才丟 `QuotaPause`。

### 3. 完成即存檔，可重播（stop／resume 的核心）

- 每個呼叫一完成，立刻把結果原子寫入 `.agentflowctl/runs/<id>/parallel-review/<輪次識別>/<slot>.json`（先寫 `.tmp` 再 rename）。內容包含審查 JSON、交接回覆、`callKey`、`source`。
- 輪次識別包含：階段、步驟、輪數，以及**輸入指紋**（計畫用 `currentPlanKey(run)`，程式碼審查用 HEAD 與 base）。指紋變了就整個目錄作廢並刪除，避免沿用過期審查。
- resume 時：同輪次識別下已有合法結果檔的 slot 直接沿用（印 `↪ 沿用本輪已完成的…`），只補跑缺的。結果檔損毀（zod 驗證失敗）視為缺，刪掉重跑。
- 這一機制取代 `planReviewLayered` 現有的 `plan-review-state.json` 進度檔裡「本輪已完成呼叫」的部分；分層審查的 `reviewed` verdict 仍留在原檔。整組審查與程式碼審查因此也第一次能沿用已完成的審查。

### 4. 序列收尾階段

平行階段全部結束後，依 slot 順序逐一處理（順序固定，resume 後結果不變）：

1. 讀結果檔（不是讀臨時 worktree），驗證審查 JSON。
2. `finishHandoff`：用結果檔內存的 `callKey`／`source` 與交接回覆，走原有的 `previewHandoff`／`acceptHandoff`。`acceptHandoff` 已有收據與 `appliedCalls`，重播冪等。
3. 失敗的呼叫走原有的 `retry`／`recordModelReviewFailure`；歸檔審查紀錄到 `reviews/`（改為寫入而非 rename，重播不會因來源檔消失而失敗）。
4. 有額度用完的呼叫時，前面成功的照常處理完，最後丟 `QuotaPause`。

在收尾階段中途被中斷也安全：結果檔還在，交接冪等，重播會從頭再走一遍收尾。

### 5. 孤兒清理

- 在 `advance()` 開頭、`recoverHandoff` 旁加一個 `cleanupParallelReview(run.id)`：刪掉 `tmp-review/` 整個目錄並執行 `git worktree prune`。因為結果檔在別的目錄，清掉不會丟資料。
- 覆蓋 SIGINT（`process.exit` 跳過 `finally`）、SIGTERM、`kill -9`、當機。
- 同一個 run 同時被兩個 `agentflowctl` 程序執行不在保證範圍（本來就不支援）。

### 6. 終端機與 log

- 平行時每行輸出加 `[<審查者>]` 前綴（既有 `info`／verbose 輸出都套用）；序列（`reviewConcurrency` 為 1 或只有一位審查者）時維持現在的格式，不加前綴。
- log 序號：在 spawn 前同步取號並立即建立空檔佔位，`nextLogFile` 的取號與建檔之間不能有 `await`。實作時先確認 `runner.ts` 現況，不符就修。
- 中斷時終端機摘要（`stopReport`）不變；平行中的多份 log 都沒有 `# exit` 尾行，`summarizeLog` 已能處理「還在執行或被中斷」。

### 7. 設定與文件

- `schemas.ts` 的 `RepoConfig` 新增 `reviewConcurrency`：正整數，optional，沒寫視為不限。
- README 補上設定欄位、平行行為、額度用完的暫停規則與 stop／resume 保證，與程式同一個 commit。
- 不新增 `FlowRun` 欄位；新增的都是 run 目錄下的檔案，舊 run 沒有這些檔案時視為「沒有已完成的呼叫」。

## 測試

- `parallelReview.test.ts`
  - 同時執行數不超過上限；結果依 slot 順序回傳。
  - 額度用完時其他呼叫仍完成並存檔，最後才 `QuotaPause`。
  - 成功、失敗、額度用完三種結束方式，臨時 worktree 都被清掉（用真的 git repo）。
  - 預算不足時不啟動超出的呼叫。
- stop／resume（重點）
  - 模擬「兩位審查者，一位完成存檔、另一位執行中被中斷」：resume 只補跑未完成的一位，已完成的不重跑、不重複付費。
  - 模擬中斷後 `tmp-review/` 殘留與 `git worktree list` 有孤兒：`advance()` 開頭清乾淨。
  - 模擬在序列收尾階段中斷：重播後帳本與不中斷時完全相同（`appliedCalls` 不重複）。
  - 輸入指紋變了（計畫被改過）：舊結果作廢重跑。
  - 結果檔損毀：視為缺，重跑。
- `engine.test.ts`：三個套用點在 `reviewConcurrency: 1` 時行為與現在完全一致；預設（不限）時結果與序列相同。
- `config` 驗證：`reviewConcurrency` 非正整數時報錯。
