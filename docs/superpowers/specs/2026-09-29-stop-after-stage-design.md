# 可指定流程停點設計

## 問題與目標

目前 `run` 會從規格一路推進到驗證、審查與 PR，只有計畫核准、額度用完、失敗或中斷時才會停下。使用者需要能在某個階段的產出已完成後先取用該產出，稍後再決定是否繼續。

本變更讓每次 run 可以指定一個公開階段作為停止邊界。流程完成該階段後保存可續接的狀態，使用者可以檢視 worktree 與 `.flow/` 產出，再用 `resume` 繼續原本的流程。

## 使用者介面

`run` 新增：

```text
--stop-after <stage>
```

接受的值為 `spec`、`plan`、`implement`、`verify`、`review`、`pr`。

各值的語意如下：

| 值 | 停止時保證的產出 |
| --- | --- |
| `spec` | `.flow/spec.md` 與 `.flow/acceptance.json` 已通過程式驗證 |
| `plan` | 計畫、任務清單與計畫審查已完成，`.flow/tasks.ordered.json` 已建立 |
| `implement` | 所有任務的測試／實作／任務審查／任務驗證已完成，工作分支包含實作 |
| `verify` | 專案測試與 checks 已通過 |
| `review` | 最終程式碼審查已通過 |
| `pr` | PR 階段已完成；有 `origin` 時已建立 PR，沒有 `origin` 時已完成本地分支流程 |

`plan_review`、`plan_fix`、`fix` 是內部迭代狀態，不接受作為停點。`pr` 會照常完成並進入 `done`，因為它本身是流程終點；其他停點會在達到邊界後進入 `paused`，並保存下一個要執行的階段。

`--manual-plan` 與 `--stop-after` 互斥，使用者必須選擇計畫審查後立即等待核准，或使用公開停點機制。`--stop-after plan` 已包含計畫審查，不會再進入 `awaiting_approval`。

## 狀態與續接

`FlowRun` 新增 optional 的 `stopAfter` 欄位，舊的 `state.json` 沒有此欄位時視為沒有指定停點。為了與額度暫停共用既有狀態，刻意停止也使用 `stage: "paused"`，並以 `pauseReason` 清楚標示「已完成指定階段」；`pausedStage` 保存下一個 active stage，供 `resume` 使用。

`advance()` 每次執行完一個 stage 並得到下一個 stage 後，檢查剛完成的公開階段是否等於 `stopAfter`。若是且目標不是 `pr`，就保存為 `paused`，不執行下一階段。若 run 已因中斷或額度暫停，`resume` 保留 `stopAfter`；當流程重新完成指定階段時仍會停下。若目前已是 `paused` 且 `pausedStage` 已超過目標，resume 直接繼續，不會回頭停。

`status` 與停止報告顯示指定停點，以及這次是「指定階段完成」還是其他原因暫停。`resume` 不接受新的停點參數，避免同一 run 在中途改變交付邊界；要改變目標應建立新的 run 或另行提供後續變更。

## 相容性與錯誤處理

- `FlowRun.stopAfter` 使用 zod optional enum，既有 run 可以正常讀取。
- CLI 對未知值、內部階段與 `--manual-plan` 同時使用都在建立 worktree 前報錯。
- 沒有 `stopAfter` 的既有 run 維持目前的 autopilot／manual-plan 行為。
- `clean --all` 的 finished 判斷不變；刻意停下的 run 必須保留，直到使用者 resume、cancel 或 clean。

## 驗證

補測試涵蓋：schema 讀取舊資料、每個公開停點的 stage 邊界、`pr` 直接完成、resume 保留與清除停點狀態、CLI 選項驗證與互斥錯誤、status／停止報告文字，以及 README 的使用方式。執行 `pnpm run typecheck` 與 `pnpm test`。
