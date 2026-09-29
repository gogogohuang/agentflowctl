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

- 位置：`.agentflowctl/runs/<id>/tmp-review/<唯一>/slot-<N>/`（`<唯一>` 是程序 id＋時間＋計數，每次建立都不同；`.agentflowctl/` 已在 exclude 內）。路徑唯一是為了不被上次中斷留下的東西擋住：git 在 `worktree add` 途中被強制中止會留下 locked 登記，被殺掉的父程序的 agent 子程序也可能還在寫舊路徑。
- 建立：`git worktree add --detach <dir> HEAD`，再把 run 的 `.flow/` 複製進去；run worktree 頂層有 `node_modules` 時建一個指向它的 symlink（Windows 用 junction），讓審查者讀得到依賴型別、跑局部測試。審查者看到的是 HEAD ＋ `.flow/` 複本＋ `node_modules` symlink，不含其他未 commit 或被 gitignore 的檔案（例如 `dist/`）。複製或建 symlink 失敗時先移除這個臨時 worktree 再丟出錯誤。
- 審查者在臨時 worktree 內工作，輸出檔與交接回覆都寫在它自己的 `.flow/`。
- 結束（成功、失敗、額度用完）後：先把結果存到 run 目錄（見 §3），再 `git worktree remove --force` 並刪掉唯一的父目錄；`remove` 失敗時刪目錄後補一次 `git worktree prune`。兩者都不會跟進 `node_modules` symlink 刪到原本的依賴。審查者亂改檔案的還原就是刪除，不再對共用 worktree 做 `discardChanges`／`restorePlan`。
- 程式碼審查開始前（寫 `diff.patch` 之前）對 run 的 worktree 做一次 `discardChanges`，清掉驗證階段留下的未 commit 修改與未追蹤產物，之後修正時的 `commitAll` 才不會把它們帶進去（冪等、resume 安全；`.flow/` 在 exclude 內不受影響）。
- 審查類步驟額度用完時 `agentStep` 直接丟 `QuotaPause`、不會在同一個 worktree 重試，所以臨時 worktree 的 `reset` 是空操作。
- `reviewConcurrency` 為 `1` 時仍走臨時 worktree，只是一次跑一個；不保留舊的共用 worktree 路徑，避免兩條路徑行為分岔。「與現在一致」指審查結果與關卡判斷一致。

### 2. 執行器：`src/parallelReview.ts`

`runParallel(run, specs, limit)`：

- semaphore 限制同時執行數為 `min(reviewConcurrency, 剩餘 agent 預算)`。啟動前以 `agentRuns(run.id)` 對照 `maxAgentRuns`，不讓平行啟動超出預算；預算不足的呼叫不啟動，交回給序列階段處理。
- 平行階段**只跑 agent、收結果**，不寫 `state.json`、不動帳本、不呼叫 `retry`。
- 每個呼叫回傳：成功的原始輸出（審查 JSON、交接回覆、`agent`／`step`／`callKey`）、失敗原因，或「額度用完」。
- 額度用完：記進 `exhausted`，其他呼叫繼續，全部結束後才丟 `QuotaPause`。

### 3. 完成即存檔，可重播（stop／resume 的核心）

- 每個呼叫一完成，立刻把結果原子寫入 `.agentflowctl/runs/<id>/parallel-review/<輪次識別>/<slot>.json`（先寫 `.tmp` 再 rename）。內容包含審查 JSON、交接回覆、`callKey`、`source`，以及**這個呼叫啟動時看到的交接帳本（`base`）**。
- 存檔是**記憶化**：以輪次識別為鍵，套用後也不刪。輪次識別包含：階段、步驟、輪數，以及**輸入指紋**（計畫用 `currentPlanKey(run)`，程式碼審查用 seed、HEAD 與 base）。指紋變了就整個目錄作廢並刪除，避免沿用過期審查。
- 沿用前還要通過**有效性檢查**：現行帳本的 `appliedCalls` 相對於該存檔 `base.appliedCalls` 多出的 callKey，必須全屬於本輪已存檔的呼叫（崩潰或同輪重跑時已套用的 slot）。多出別的呼叫（例如分層審查 `plan-handoff` 退回後修正者只回覆交接、沒改計畫檔，或任務修正者沒有 commit，輪數與指紋都沒變）代表審查者沒看過現在的帳本，存檔作廢並重跑。
- resume 時：同輪次識別下已有合法且有效結果檔的 slot 直接沿用（印 `↪ 沿用本輪已完成的…`），只補跑缺的。結果檔損毀（zod 驗證失敗，含缺少 `base` 的舊格式）視為缺，刪掉重跑。`openRound`、`loadCalls` 與有效性檢查都在任何呼叫啟動之前做（`loadCalls` 會刪 `.tmp`）。
- 只存「agent 執行成功」的結果；執行失敗的呼叫不存檔（resume 後照原本的重試流程重跑）。序列收尾階段判定某份已存結果不合格（格式錯誤、交接矛盾）時，立刻刪掉那份結果檔，否則同一輪重跑會反覆讀到同一份壞結果。
- 這一機制與 `planReviewLayered` 現有的 `plan-review-state.json` 並存：存檔結果是「agent 已跑完」的記憶化結果（套用與否都在），進度檔記的是「已套用」的呼叫與分層 `reviewed` verdict，兩者各管一段，不合併。整組審查與程式碼審查因此也第一次能沿用已完成的審查。

### 4. 序列收尾階段

平行階段全部結束後，依 slot 順序逐一處理（順序固定，resume 後結果不變）：

1. 讀結果檔（不是讀臨時 worktree），驗證審查 JSON。
2. `finishHandoff`：用結果檔內存的 `callKey`／`source` 與交接回覆，走原有的 `previewHandoff`／`acceptHandoff`。核准門檻（「核准卻仍有未結交接事項」）以**該呼叫自己存檔的 `base`** 加上它的回覆評估，不用現行帳本、也不用全輪單一快照：審查者只看得到它啟動時的帳本，同輪其他審查者剛新增（或崩潰前已套用）的事項不能拿來判它矛盾；重跑的呼叫看到的是較新的帳本，就用它自己的。套用仍落在現行帳本。`acceptHandoff` 已有收據與 `appliedCalls`，重播冪等。
3. 失敗的呼叫走原有的 `retry`／`recordModelReviewFailure`；歸檔審查紀錄到 `reviews/`（改為寫入而非 rename，重播不會因來源檔消失而失敗）。
額度用完時不進入收尾階段：平行階段結束後若有呼叫額度用完，直接丟 `QuotaPause`。成功的呼叫此時已存檔，resume 後會被沿用並在收尾階段套用，不會丟失也不會重跑。

在收尾階段中途被中斷也安全：結果檔還在，交接冪等，門檻以各自的 `base` 評估，重播會從頭再走一遍收尾，結果與不中斷時相同。

### 5. 孤兒清理

- 在 `advance()` 開頭、`recoverHandoff` 旁呼叫 `cleanupTempWorktrees(run.id)`（`clean` 也會呼叫）：先從 `git worktree list --porcelain` 找出登記在 `tmp-review/` 下的 worktree，逐個 `git worktree remove -f -f`（雙 `-f` 才移除 locked 的），再刪掉 `tmp-review/` 整個目錄（`maxRetries`）並執行 `git worktree prune`。清理失敗只印一行警告、不讓 `advance` 崩潰；新的臨時 worktree 用唯一路徑，不會被殘骸擋住。因為結果檔在別的目錄，清掉不會丟資料。
- 覆蓋 SIGINT（`process.exit` 跳過 `finally`）、SIGTERM、`kill -9`、當機。
- 同一個 run 同時被兩個 `agentflowctl` 程序執行不在保證範圍（本來就不支援）。

### 6. 終端機與 log

- 平行時 `agentStep` 印出的引擎訊息加 `[<審查者>]` 前綴；agent 回報的疑慮與 verbose 輸出不加。序列（`reviewConcurrency` 為 1 或只有一位審查者）時不加前綴、訊息文字不變，但順序不再逐位交錯：所有 🧐／👀 行在審查者啟動前一次印出，✓／✗ 在全部跑完後的收尾階段印出。
- log 序號：`nextLogFile` 取號到 `runAgent` 寫入檔頭之間沒有 `await`（已確認），所以同時啟動的呼叫不會撞號。不改程式，只加測試鎖住這個性質。
- 審查者不再能改到共用的 `.flow/`，「已還原審查者修改的檔案」這行訊息不再出現；改由測試斷言共用的 `.flow/` 與程式碼完全沒被動到。
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
  - 模擬在序列收尾階段中斷（分裂裁決：slot 0 要求修改並新增事項、slot 1 核准；slot 0 已 `acceptHandoff`、run 尚未存檔）：resume 沒有 `handoff_invalid`、沒有多跑 agent，階段、重試、帳本與不中斷時完全相同。整份計畫審查與程式碼審查各一個。
  - 輸入指紋變了（計畫被改過、HEAD 變了）：舊結果作廢重跑。
  - 同一輪、同指紋重進，但帳本多了本輪以外的呼叫（修正者的交接）：舊結果作廢重跑；只多了本輪 slot 的呼叫（崩潰重用）仍沿用。
  - 結果檔損毀（含缺少 `base` 的舊格式）、寫到一半的 `.tmp`：視為缺，刪掉重跑。
- `tempWorktree.test.ts`：同 slot 名稱每次建立的實體路徑不同、basename 不變；locked 的殘留登記（目錄在或不在）都能清掉，`clean` 也會清；複製 `.flow/` 失敗時不留下登記；`node_modules` symlink 讀得到，移除後原本的依賴完好。
- 程式碼審查前清掉 run worktree 的未 commit 修改與未追蹤產物。
- `runPool` 某項丟例外後排隊中的項目仍會執行，最後丟出第一個例外。
- claude adapter 的權限設定檔內容沒變時不重寫（並行時不會被截斷）。
- `engine.test.ts`：三個套用點在 `reviewConcurrency: 1` 時行為與現在完全一致；預設（不限）時結果與序列相同。
- `config` 驗證：`reviewConcurrency` 非正整數時報錯。
