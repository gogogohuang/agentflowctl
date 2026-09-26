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
pnpm dev doctor                           # 用 tsx 直接跑 src/cli.ts
```

CI（`.github/workflows/ci.yml`）在 ubuntu／macos × Node 22／24 跑 typecheck、test、build。發布是在 GitHub 建 Release 時自動做的：版本號取自 tag，`package.json` 的 version 不需要手動改。

測試檔 `src/**/*.test.ts` 與原始碼放在一起，tsconfig 會把它們排除在 build 之外。`git.test.ts` 會建立真的 git repo。

## 架構

一次 run 就是一台狀態機，全程由程式推進，是否通過一律由程式檢查（跑測試、比對 git diff、zod 驗證 JSON），不看 agent 自己怎麼說。

- **`engine.ts`：狀態機。** `advance()` 反覆呼叫 `STAGES[stage](run)`，每一步後都用 `saveRun` 原子寫入 `state.json`，所以任何時候中斷都能 `resume`。階段依序是 spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（紅燈：寫測試／綠燈：寫實作）→ verify ⇄ fix → review ⇄ fix → pr。沒通過時呼叫 `retry()`：把原因寫進 `.flow/feedback.md` 給下一次嘗試參考，連續超過 `maxAttempts` 次就讓 run 失敗；通過時呼叫 `succeed()`。
- **`agentStep()`（engine.ts）：額度處理。** 步驟分成 `review` 與 `write` 兩類。額度用完時，`review` 類丟出 `QuotaPause` 讓 run 暫停，因為換人代審可能變成作者審自己；`write` 類則先 `reset` 清掉半成品，再隨機由另一家還有額度的 agent 代打，並記進 `substitutions.jsonl`。
- **`roles.ts`：誰負責哪一步。** 角色分配寫成純函式，人選隨機但以 run id 加步驟為種子（resume 時不變），例如審查者一定不是最後的作者、測試與實作由不同家負責（`tddSplit`）、`fixStrategy` 決定修正者、仲裁者的挑選。要改角色分配就改這裡，並補上 `roles.test.ts`。
- **`runner.ts` 與 `agents/`：執行 agent。** 每種 adapter 提供 `probe`、`invoke`（組出 cmd／args／stdin／env）與 `parse`（把一行 stdout 轉成正規化的 `AgentEvent`：text／tool／usage／done）。額度錯誤靠 `QUOTA_PATTERNS` 比對錯誤訊息，而且只在執行失敗時才檢查。回覆結尾的 `<result>` XML 由 `parseResultMeta` 解析，只給人看，不影響關卡判斷。`runCommand` 則用 shell 在 worktree 內跑專案的 install／test／checks。終端機預設安靜：💬／🔧／`$ 指令` 只在 `config.verbose`（`-v` 或 `AGENTFLOWCTL_VERBOSE=1`）時印出。
- **`logs.ts`：log 格式。** 檔名由 `nextLogFile` 產生（序號-階段-步驟-agent），檔頭 `# agentflowctl {...}`、檔尾 `# exit {...}` 由 runner 寫入，中間原樣保存 agent 的 stdout。`renderLog` 在顯示時才用 adapter 的 `parse` 解析，並整理出錯誤段落；新增 adapter 或事件格式時，解析結果會自動反映在 `logs` 指令。
- **隔離方式。** 每個 run 有自己的 git worktree（`.agentflowctl/worktrees/<id>`，分支 `flow/<id>`），agent 只在那裡工作。run 的資料放在 `.agentflowctl/runs/<id>/`（`state.json`、`costs.jsonl`（存的其實是用量）、`logs/`、`reviews/`、`claude-settings.json`）。agent 之間交接的檔案放在 worktree 內的 `.flow/`，例如 `spec.md`、`acceptance.json`、`plan.md`、`tasks.json`、`feedback.md`、`verify.json`、`review.json`。路徑一律從 `paths.ts` 取得。
- **設定。** `flow.config.json` 放在主專案根目錄，由 `schemas.ts` 的 `RepoConfig` 驗證並補上預設值；沒寫的 `install`／`test`／`checks` 由 `detect.ts` 依 `packageManager`、lockfile 與 `package.json` scripts 推出（不寫檔），指令本身仍以 Vite + TS + Vitest 為底。每次都重新讀取，所以未 commit 的修改也會生效。`agentConfig.ts` 實作 `agentflowctl agent ...` 系列指令，寫入前會先驗證整份設定；`setup.ts` 是 `agent setup` 的互動精靈，問答以注入的 `ask` 進行，只組出設定、不直接寫檔。沒有內建 agent：所有 agent 都要定義在 `agents`（`resolveAgent` 只查這裡），沒設定 `cycle` 時由 `cli.ts` 的 `resolveCycle` 依 `agents` 的順序挑出已安裝的，一個都沒有就報錯。環境變數 `AGENTFLOWCTL_MAX_ATTEMPTS` 等定義在 `config.ts`。
- **Prompt。** `prompts/<stage>.md` 由 `renderPrompt` 代入 `{{變數}}`，少了變數會直接丟錯。每個 prompt 都用 XML 分段（`<role>`、`<context>`、`<inputs>`、`<steps>`、`<constraints>`、`<output_format>`、`<reply_format>`），並要求回覆附上 `<result>` 區塊。新增或修改變數時，要同步改 engine 裡對應的 `renderPrompt` 呼叫。`prompts/` 會隨 npm 套件一起發布。

## 改動時注意

- 每一次更動使用者看得到的行為（指令、選項、設定欄位、終端機輸出、階段流程），都要在同一個 commit 更新 `README.md`。
- 各家 CLI 的參數與事件格式變動很快。改 adapter 時，要在 `agents/adapters.test.ts` 用實際的 JSON 行補測試。
- 新增 run 狀態欄位要改 `schemas.ts` 的 `FlowRun`。新欄位要設成 optional，進行中 run 的舊 `state.json` 才讀得進來。
- 關卡判斷要以程式能檢查的事實為準（檔案、diff、測試結果），不要改成依賴 agent 回覆的內容。
