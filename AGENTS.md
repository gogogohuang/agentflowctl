# AGENTS.md

給在這個 repo 工作的 coding agent（Claude Code、Codex、Gemini CLI……）的專案說明。

agentflowctl 是一個 Node.js（>=22）CLI：讓 Claude Code、Codex、Gemini CLI 輪流寫規格、計畫、測試、實作並互相審查，一路做到開 PR。程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。

## 指令

```bash
pnpm install
pnpm run typecheck                        # tsc --noEmit
pnpm test                                 # vitest run（全部）
npx vitest run src/runner.test.ts         # 單一檔案
npx vitest run -t "adapter 事件解析"       # 依測試名稱篩選
pnpm run build                            # tsc → dist/（bin 指向 dist/cli.js）
pnpm dev config doctor                    # 用 tsx 直接跑 src/cli.ts
pnpm release patch --dry-run              # 本機發版（限 main）；patch|minor|major|x.y.z，去掉 --dry-run 才會建立 GitHub Release
```

CI（`.github/workflows/ci.yml`）在 ubuntu／macos × Node 22／24 跑 typecheck、test、build。發版由 `scripts/release.sh`（`pnpm release`）處理：它會把 `package.json` 的 version 更新、commit、push 到 `main`，再建立 GitHub Release；npm 發布則由 Release 觸發的 `npm-publish.yml` 接手，`package.json` 的 version 不需要手動改。

測試檔 `src/**/*.test.ts` 與原始碼放在一起，tsconfig 會把它們排除在 build 之外。`git.test.ts` 會建立真的 git repo。

## 架構

一次 run 就是一台狀態機，全程由程式推進，是否通過一律由程式檢查（跑測試、比對 git diff、zod 驗證 JSON），不看 agent 自己怎麼說。

- **`engine.ts`：狀態機。** `advance()` 反覆呼叫 `STAGES[stage](run)`，每一步後都用 `saveRun` 原子寫入 `state.json`，所以任何時候中斷都能 `resume`。階段依序是 spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（每個任務依 `taskPhase` 走：紅燈寫測試 → 綠燈寫實作 → 任務審查 → 任務驗證，未通過進任務修正後重新審查；測試或實作在寫檔前若連續合格失敗達 `diverge.after`、或綠燈退回測試，先由 `maybeDiverge` 跑短發散再重試，結論只追加進 feedback，不影響關卡）→ verify ⇄ fix → review ⇄ fix → pr。任務夠多且能分群時（`planReviewLayers`），`plan_review` 每輪先索引再只審有變動的群；狀態放在 run 目錄。`replan`（`replanRun`）讓人在等待核准或停在計畫階段時補充意見（寫成 `.flow/feedback.md` 交給 plan_fix）或手改 `.flow/` 計畫檔：先 `validatePlan`，通過才改 run；`skipPlanReview` 讓修訂完直接 `planSettled`。`iterate`（`iterateRun`）讓 `done` 的 run 在同一個 worktree 開下一輪：上一輪的規格與計畫存進 `.flow/round-N/`，清掉其餘交接檔與第一輪的確認、仲裁、車道紀錄，回到 spec；`FlowRun.round` 記輪次，`prStage` 有 `prUrl` 時只推送不再建 PR。沒通過時呼叫 `retry()`：把原因寫進 `.flow/feedback.md` 給下一次嘗試參考，連續超過 `maxAttempts` 次就讓 run 失敗；通過時呼叫 `succeed()`。
- **`agentStep()`（engine.ts）：額度處理。** 每次啟動 CLI 前先以 `store.ts` 的 `reserveAgentRun`（key 為所屬 run，車道共用，只存在程序記憶體）保留一格額度、`finally` 釋放；不足時丟 `AgentBudgetError`，由 `advance()`、`driveLane`、`executeReviewCalls` 映射成 `agent_budget` 失敗（不是 `QuotaPause`）。replan 進入時 `restoreHumanItems` 先把確認項目併回 `.flow/`，驗證失敗會整個還原。 步驟分成 `review` 與 `write` 兩類。額度用完時，`review` 類丟出 `QuotaPause` 讓 run 暫停，因為換人代審可能變成作者審自己；`write` 類則先 `reset` 清掉半成品，再隨機由另一家還有額度的 agent 代打，並記進 `substitutions.jsonl`。
- **`roles.ts`：誰負責哪一步。** 角色分配寫成純函式，人選隨機但以 run id 加步驟為種子（resume 時不變），例如審查者一定不是最後的作者、測試與實作由不同家負責（`tddSplit`）、`fixStrategy` 決定修正者、仲裁者的挑選。要改角色分配就改這裡，並補上 `roles.test.ts`。
- **`lanes.ts`：平行任務。** 沒有相依關係的任務各占一條「車道」：`paths.ts` 把 `<run id>+<任務 id>` 當成一個小 run 的 id（`laneParts`／`laneId`／`ownerId`），它有自己的 `state.json`、worktree（`runs/<id>/lanes/<任務>/worktree`）與 `.flow/`，但 `logDir`、`handoffPath` 與 store 的用量／重試／代打都導向所屬 run，所以統計、`maxAgentRuns` 與交接帳本不必合併。`engine.ts` 的 `implementStage` 在兩個以上任務同時可開始（或 `doneTasks`／既有車道存在）且 `taskConcurrency` 不是 1 時改走 `implementLanes`：`lanes.ts` 的 `scheduleLanes` 只管排程（就緒的任務開車道、完成一個合併一個、衝突重做、失敗或暫停就不再開新車道），車道用原本的 `implementStage` 跑單一任務（`.flow/tasks.ordered.json` 第一個是自己，後面是還沒完成的其他任務，讓「不可動後面任務的檔案」照常比對），合併用 `git.ts` 的 `mergeBranch`。車道的 `testCmd` 與 `runChecks` 不跑 install（`node_modules` 是共用 symlink）。`FlowRun.doneTasks` 記已合併的任務，`taskOffset` 讓角色輪替與順序執行一致。`advance()` 停下時要接在最新存檔的狀態上（階段中途會存檔）。
- **`parallelReview.ts` 與 `tempWorktree.ts`：平行審查。** 同一輪的審查者（整份計畫審查、分層審查的索引與各群、程式碼審查）由 `engine.ts` 的 `executeReviewCalls` 平行執行：每位在 `tempWorktree.ts` 建的臨時 worktree（HEAD ＋ `.flow/` 複本＋ `node_modules` symlink）裡跑，成功的結果由 `parallelReview.ts`（限流執行器 `runPool` 與審查結果存檔）原子存進 run 目錄，全部結束後才依 slot 順序序列套用（驗證、交接、retry）。存檔以輪次＋輸入指紋為鍵、帶著呼叫啟動時看到的帳本（核准門檻以它評估），帳本被本輪以外的呼叫動過就作廢重跑。`advance()` 開頭用 `cleanupTempWorktrees` 清掉中斷留下的臨時 worktree。
- **`runner.ts` 與 `agents/`：執行 agent。** 每種 adapter 提供 `probe`、`invoke`（組出 cmd／args／stdin／env）與 `parse`（把一行 stdout 轉成正規化的 `AgentEvent`：text／tool／usage／done）。額度錯誤靠 `QUOTA_PATTERNS` 比對錯誤訊息，而且只在執行失敗時才檢查。回覆結尾的 `<result>` XML 由 `resultMeta.ts` 的 `parseResultMeta` 解析，只給人看，不影響關卡判斷。`runCommand` 則用 shell 在 worktree 內跑專案的 install／test／checks。終端機預設安靜：💬／🔧／`$ 指令` 只在 `config.verbose`（`-v` 或 flow.config.json 的 `verbose`）時印出。
- **`reviewCoverage.ts`：審查結果對照驗收條件。** `codeReview` 讀到 `review.json` 後用 `checkReviewCoverage` 檢查：範圍內每條 `AC-n` 都要有一筆回報（任務審查是該任務的條件，整體審查是全部）、不能有不存在的編號、額外發現（criterion 不是 `AC-n`）要附 `evidence`，不合格以 `format_invalid` 重審。`splitUnmet` 把未通過項目分成驗收條件與額外發現，後者在 feedback 以 `<extra_finding>` 分開標示，且只在重試計數為 0（`EXTRA_BLOCK_ATTEMPTS`）時能擋關，之後降為交接帳本的 `info`。
- **`testGuard.ts` 的 `weakenedChecks`。** `applyFix` 與綠燈階段用 `git diff` 偵測新增的 skip／only／todo、`@ts-ignore`／`@ts-nocheck`／`eslint-disable` 與測試檔斷言減少（以檔案內新增與移除相抵），以 `checks_weakened` 退回；斷言減少只在前 `SCOPE_GUARD_ATTEMPTS` 次擋。`tasks.ts` 的 `outOfScopeFiles` 除了明寫路徑，也認得描述裡的目錄與根目錄檔案。
- **任務級狀態的重置。** `engine.ts` 的 `TASK_RESET`（taskPhase、taskBase、testsCommit、lastTestsAuthor、testsRedos、taskRounds）與 `NO_WRITER_CONTEXT`（lastWriter、lastReviewer、fixSource）集中定義開始或重新開始一個任務要歸零的欄位，`finishTask`、車道重做、修補、`redoTests`、`iterate`、`planSettled` 都用展開的方式套用，不要自己挑欄位清。新增任務級欄位時加在這裡。
- **`verify` 的重跑與 flaky。** `runChecks` 在 `rerunFailedChecks`（預設開）時，失敗的檢查先原樣重跑一次（log 步驟名加 `-rerun`）；第二次通過視為 flaky，放行並由 `store.ts` 的 `addFlaky` 記進 `flaky.jsonl`（不寫 `retries.jsonl`：`maybeDiverge` 會數它）。`dump.ts` 的 `RUN_ENTRIES` 已含這個檔案。
- **作者疑慮與計畫檢查。** `settleHandoff` 在關卡通過後用 `recordConcerns` 把 `<result><concerns>` 記成交接帳本的 `info`，審查者從 `handoff-context.md` 看到；只是線索，記錄失敗不能影響步驟。`validatePlan` 在 `taskConcurrency` 不是 1 時用 `tasks.ts` 的 `overlappingParallelTasks` 擋下沒有相依關係卻描述同一批檔案的任務。`insights.ts` 的 `RETRY_RULES` 把每個重試類別對應到相關規則，新增 `RetryCategory` 時要補。
- **綠燈階段的回歸與圈數上限。** 綠燈失敗時先用 `foreignFailingTests` 判斷失敗的是不是別的（前面任務的）測試檔：是的話不走 `redoTests`，第一次退回實作者並提示 amend，連續 `REGRESSION_PAUSE_AFTER` 次丟 `RegressionPause`。`capTaskRounds` 數任務級「審查／驗證未通過 → 修正」的圈數（`FlowRun.taskRounds`），超過 `maxTaskRounds` 丟 `TaskRoundsPause`；兩者都沿用 `QuotaPause` 的暫停流程，暫停前先存檔讓 resume 重新計數。
- **`packageExports.ts`：紅燈階段的靜態檢查。** 測試提交後、叫實作者前，在 worktree 內 require 測試檔以函式呼叫的套件匯出，缺少時以 `tests_invalid` 退回測試作者；載入失敗一律略過。綠燈階段的對應判斷在 `testGuard.ts` 的 `brokenPackageImport`，退回測試階段達上限時丟 `TestsStuckPause` 暫停。
- **`logs.ts`：log 格式。** 檔名由 `nextLogFile` 產生（序號-階段-步驟-agent），檔頭 `# agentflowctl {...}`、檔尾 `# exit {...}` 由 runner 寫入，中間原樣保存 agent 的 stdout。`renderLog` 在顯示時才用 adapter 的 `parse` 解析，並整理出錯誤段落；新增 adapter 或事件格式時，解析結果會自動反映在 `logs` 指令。`renderLog` 預設精簡工具內容（`--full` 才完整）。`summarizeLog` 取出一份 log 的結果，供 `stopReport.ts` 在 run 停下時（Ctrl-C、失敗、暫停、等待核准，以及 `status`）印出結果、未結交接事項與下一步指令。
- **`dump.ts`：隱藏的除錯指令。** `agentflowctl dump <id> [outDir]` 以 `hidden: true` 註冊（不在 `--help`、不寫進 README），把單一 run 的資料、`.flow/`、設定與 git 狀態複製成一個目錄（預設 `.agentflowctl/dumps/`）。新增 run 資料檔時記得同步 `RUN_ENTRIES`。`agentflowctl restore <dumpDir>`（同樣 hidden）反向還原：`restoreRun` 沿用原 id，寫回 run 紀錄與 `.flow/`、用既有的 `flow/<id>` 分支重建 worktree；run 已存在或分支不在就拒絕，`flow.config.json` 不覆蓋，`state.json` 最後寫入。
- **`insights.ts` 與 `usageInsights.ts`。** `insights.ts` 彙總結果、失敗原因與重試；`usageInsights.ts` 彙總用量與規則式建議；步驟合併在 `stats.ts` 的 `mergeStats`。跨 run 讀各 run 的 `costs.jsonl`、`retries.jsonl`、`substitutions.jsonl` 與 logs 檔頭檔尾。
- **隔離方式。** 每個 run 有自己的 git worktree（`.agentflowctl/worktrees/<id>`，分支 `flow/<id>`），agent 只在那裡工作。run 的資料放在 `.agentflowctl/runs/<id>/`（`state.json`、`confirmations.json`＋`confirmation-details.json`＋`confirmations-restored`（replan 把確認項目併回 `.flow/` 後留下的空標記；有標記或尚無確認檔時定案才由 `.flow/` 重建，否則沿用既有資料）（計畫定案時從 `.flow/` 搬出的人工確認項目，只在開 PR 時使用）、`costs.jsonl`（存的其實是用量）、`retries.jsonl`、`logs/`、`reviews/`、`claude-settings.json`、`plan-review-state.json`、`plan-arbitration.json`、`diverge.json`（重試前短發散的結果與去重標記，放在 worktree 外）、`parallel-review/`（平行審查已完成呼叫的存檔）、`tmp-review/`（審查者的臨時 worktree，固定為 `slot-<N>/`，被占用時才改用唯一子目錄））。agent 之間交接的檔案放在 worktree 內的 `.flow/`，例如 `spec.md`、`acceptance.json`、`plan.md`、`tasks.json`、`plan-replies.md`、`feedback.md`、`verify.json`、`review.json`。路徑一律從 `paths.ts` 取得。
- **設定。** `flow.config.json` 放在主專案根目錄，由 `schemas.ts` 的 `RepoConfig` 驗證並補上預設值；沒寫的 `install`／`test`／`checks` 由 `detect.ts` 依 `packageManager`、lockfile 與 `package.json` scripts 推出（不寫檔），指令本身仍以 Vite + TS + Vitest 為底。每次都重新讀取，所以未 commit 的修改也會生效。`agentConfig.ts` 實作 `agentflowctl config agent ...` 系列指令，寫入前會先驗證整份設定；`setup.ts` 是 `config agent setup` 的互動精靈，問答以注入的 `ask` 進行，只組出設定、不直接寫檔。沒有內建 agent：所有 agent 都要定義在 `agents`（`resolveAgent` 只查這裡），沒設定 `cycle` 時由 `cli.ts` 的 `resolveCycle` 依 `agents` 的順序挑出已安裝的，一個都沒有就報錯。執行次數上限：`maxAgentRuns` 只管計畫定案前，`planSettled` 定案時改為「已執行次數＋任務數×`agentRunsPerTask`」（`FlowRun.maxAgentRunsExplicit` 為真，即 run／resume 明確指定過，就不改算）。不使用環境變數：重試上限（`maxAttempts`）、`verbose` 等都放在 `flow.config.json`，`config.ts` 只放執行期旗標與 `MIN_ATTEMPTS`。
- **Prompt。** `prompts/<stage>.md` 由 `renderPrompt` 代入 `{{變數}}`，少了變數會直接丟錯。每個 prompt 都用 XML 分段（`<role>`、`<context>`、`<inputs>`、`<steps>`、`<constraints>`、`<output_format>`、`<reply_format>`），並要求回覆附上 `<result>` 區塊。新增或修改變數時，要同步改 engine 裡對應的 `renderPrompt` 呼叫。`prompts/` 會隨 npm 套件一起發布。

## 改動時注意

- 每一次更動使用者看得到的行為（指令、選項、設定欄位、終端機輸出、階段流程），都要在同一個 commit 更新 `README.md`。
- 各家 CLI 的參數與事件格式變動很快。改 adapter 時，要在 `agents/adapters.test.ts` 用實際的 JSON 行補測試。
- 新增 run 狀態欄位要改 `schemas.ts` 的 `FlowRun`。新欄位要設成 optional，進行中 run 的舊 `state.json` 才讀得進來。
- 關卡判斷要以程式能檢查的事實為準（檔案、diff、測試結果），不要改成依賴 agent 回覆的內容。
