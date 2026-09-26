# agentflowctl

讓 Claude Code、Codex、Gemini CLI（或任何 agent CLI）在同一條流程裡輪流寫規格、寫計畫、寫測試、寫實作、互相審查、互相修正，一路做到開 PR。

```
需求 → spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（測試 A → 實作 B）→ verify ⇄ fix → review ⇄ fix → pr
```

從需求到 PR 全程由程式推進。每個步驟都是一次獨立的 agent 執行，用 `.flow/` 裡的檔案交接。是否通過一律由程式檢查：跑測試、比對 git diff、驗證 JSON。兩家模型就能完整運作；有第三家時，仲裁會交給沒參與討論的那一家。

## 快速開始

需要 Node.js 22 以上與 git。不需要全域安裝，直接用 `npx` 執行。先讓各家 CLI 完成訂閱登入，再檢查環境：

```bash
claude    # 完成登入
codex     # 完成登入
npx agentflowctl doctor
```

`doctor` 會列出已安裝的 CLI，並印出即將使用的輪替順序。沒有 `flow.config.json` 時，會自動採用偵測到的 CLI。

在專案資料夾內開始一次 run：

```bash
npx agentflowctl run --req "登入表單加上 zod 驗證與錯誤訊息"
```

想把指令縮成 `agentflowctl` 時，再全域安裝：

```bash
npm install -g agentflowctl
```

下面的指令都寫成 `agentflowctl`；沒有全域安裝時，在前面加上 `npx` 即可。

這次 run 在專用 git worktree（`.agentflowctl/worktrees/<id>`）裡工作，基底是你目前的分支，新分支名是 `flow/<id>`。你正在編輯的工作目錄不會被改到。

從原始碼安裝：

```bash
git clone https://github.com/gogogohuang/agentflowctl.git
cd agentflowctl
pnpm install
pnpm run build
pnpm link --global
```

## 輪替怎麼打破同溫層

同一個模型審查自己的程式碼，容易放過自己的寫法；測試和實作出自同一個模型，也容易寫出剛好會過的測試。角色分配只有三條規則，定義在 `src/roles.ts`：

| 規則 | 效果 |
|---|---|
| 審查者永遠不是最後寫程式的 agent | 每一輪審查都由另一家看 |
| 同一個任務的測試與實作由不同 agent 負責（`tddSplit`） | A 寫的測試，B 實作到通過，而且不能改測試 |
| 所有角色沿著同一個輪替順序前進 | 各家輪流當作者、審查者、修正者 |

兩家時是乒乓。輪替順序 `claude → codex` 會跑成：

```
計畫：claude 撰寫 → codex 審查（要求修改）→ claude 修改 → codex 審查（核准）
T-1  測試：claude   實作：codex
T-2  測試：codex    實作：claude
審查：codex（最後作者是 claude）→ 要求修改 → claude 修正 → codex 審查（核准）
```

三家時，修正與審查會一直換人。例如 codex 寫、gemini 審、claude 修；仲裁交給沒寫過這份計畫、也沒審過它的那一家。

每個 commit 訊息結尾會標上實際作者，例如 `feat(T-2): 匯出 [gemini]`。

只裝一家也能跑完，只是審查、測試、實作都會落在同一家。

## 指令

```bash
agentflowctl run --req "..."
agentflowctl run --req-file ./req.md --cycle codex,claude --max-agent-runs 40
agentflowctl run --req "..." --manual-plan   # 計畫通過 AI 審查後，仍停下來等你確認

agentflowctl approve f-xxxx        # 搭配 --manual-plan
agentflowctl status f-xxxx         # 階段、任務進度、各 agent 用量、代打紀錄
agentflowctl list
agentflowctl logs f-xxxx           # 列出每一份 log 的編號、結果、階段、步驟、agent
agentflowctl logs f-xxxx 7         # 解析第 7 份 log，最後附上錯誤整理（--latest 看最新一份）
agentflowctl logs f-xxxx 7 --raw   # 原始內容（agent 的 JSON 行）
agentflowctl resume f-xxxx         # 從暫停、Ctrl-C 或失敗處接續
agentflowctl cancel f-xxxx
agentflowctl clean f-xxxx          # 移除 worktree 與 run 紀錄，分支保留
```

| 選項 | 作用 |
|---|---|
| `--req` / `--req-file` | 需求文字，或從檔案讀取 |
| `--base` | 基底分支，預設為目前分支 |
| `--cycle` | 這次 run 的輪替順序，例如 `claude,codex,gemini`；建立後就固定，`resume` 沿用 |
| `--max-agent-runs` | 這次 run 的 agent 執行次數上限 |
| `--manual-plan` | 計畫通過審查後進入 `awaiting_approval`，等 `approve` 才開始實作 |
| `-v` / `--verbose` | 執行時印出 agent 的文字、工具呼叫與專案指令；`run`、`resume`、`approve` 都適用，也可設 `AGENTFLOWCTL_VERBOSE=1` |

`status` 會列出任務。進行中的任務會標出正在寫測試還是正在寫實作。

### 執行中的終端機輸出

預設是安靜模式，只印出 `[run-id]` 開頭的階段進度（📝 🧐 ✓ ✗ ⚠️ 等）。agent 執行失敗、測試或檢查沒過時，會附上對應 log 的查看指令：

```
[f-xxxx] 🔍 執行驗證
[f-xxxx]    ✓ typecheck
[f-xxxx]    ✗ lint（agentflowctl logs f-xxxx 15）
    ✗ codex 執行失敗（結束碼 1），可用 agentflowctl logs f-xxxx 16 查看
```

加上 `-v` 會另外印出 agent 每一段文字的第一行、每次工具呼叫的完整指令或主要參數（不截斷，多行指令的後續行縮排對齊），以及 install、測試、verify 這些以 `$ ` 開頭的專案指令：

```
    💬 [claude] 先讀現有的表單元件
    🔧 [claude] Read: /repo/.agentflowctl/worktrees/f-xxxx/src/LoginForm.tsx
    🔧 [claude] Bash: pnpm vitest run src/LoginForm.test.tsx
    🔧 [codex] shell: bash -lc 'pnpm test'
    🔧 [gemini] run_shell_command: npm run lint
    $ pnpm install
```

工具參數依序取 command、檔案路徑、path、pattern、url、query，都沒有時印出整包 JSON。

### Log

每次執行 agent 或專案指令都會留一份 log，放在 `.agentflowctl/runs/<id>/logs/`，檔名是「序號-階段-步驟-agent」，專案指令的 agent 欄位是 `cmd`：

```
001-setup-install-cmd.log
002-spec-spec-claude.log
007-implement-T1-tests-codex.log
008-implement-T1-red-cmd.log
015-verify-lint-cmd.log
```

檔案保留 agent 的原始輸出，也就是各家 CLI 的 JSON 行。第一行 `# agentflowctl {...}` 記錄階段、步驟、agent 與開始時間；stderr 接在 `[stderr]` 之後；最後一行 `# exit {...}` 記錄結束碼與是否成功，沒有這行就代表還在執行或被中斷。

`agentflowctl logs <id> <編號>` 會把原始 JSON 解析成易讀的格式：💬 agent 的完整文字、🔧 工具呼叫、📊 用量、🏁 最後結果、⚠️ 工具回報的錯誤、❌ adapter 不認得的錯誤事件、📄 非 JSON 的輸出。最後一段「錯誤」整理出結束碼、agent 回報的失敗、錯誤事件和 stderr。run 失敗時，`status` 也會指出最後一份 log 和最近失敗的那份。

## 設定

專案根目錄的 `flow.config.json`。完整範例見 `examples/flow.config.json`。未提供的欄位使用內建預設（安裝指令、測試指令、檢查清單預設對應 Vite + TypeScript + Vitest）。

```json
{
  "cycle": ["claude", "codex"],
  "fixStrategy": "ring",
  "tddSplit": true,
  "tieBreak": "proceed",
  "agents": {
    "codex": { "adapter": "codex", "model": "你要用的模型" },
    "aider": { "adapter": "command", "command": ["aider", "--yes-always", "--no-auto-commits", "--message", "{prompt}"] }
  }
}
```

| 設定 | 預設 | 說明 |
|---|---|---|
| `cycle` | 自動偵測 | 輪替順序。同一家 CLI 可以登記成不同 agent，例如 `claude-fast` 與 `claude-strong` |
| `fixStrategy` | `ring` | `ring`：審查意見交給審查者的下一位；`author`：交回最後作者 |
| `tddSplit` | `true` | 測試與實作是否分開 |
| `reviewQuorum` | `1` | 程式碼需要幾位不同審查者都 `approve` |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者都 `approve` |
| `planArbiter` | `true` | 計畫審查僵持時交付仲裁。關掉之後，僵持會直接讓 run 失敗 |
| `tieBreak` | `proceed` | 兩家仲裁意見分歧時：`proceed` 繼續並記錄爭議；`stop` 停下 |
| `maxAgentRuns` | `60` | 單一 run 最多執行幾次 agent |
| `install` / `test` / `checks` | 見 `src/schemas.ts` | verify 階段實際執行的指令 |
| `agents` | 內建 claude、codex、gemini | 覆寫內建 agent，或用 `command` adapter 接上其他 CLI |
| `removedAgents` | `[]` | 移除的內建 agent，不會被自動偵測、不能放進輪替。通常用 `agent remove` 寫入 |

verify 失敗（型別、lint、建置）一律交回最後作者。審查意見才依 `fixStrategy` 決定修正者。

### 用指令管理 agent

`agents` 與 `cycle` 也可以用 `agent` 指令修改，不必手動編輯 JSON。每次寫入前都會先驗證整份設定：

```bash
agentflowctl agent list                                   # 內建與自訂 agent、是否已安裝、輪替位置
agentflowctl agent add claude-strong --adapter claude --model opus
agentflowctl agent add aider --adapter command -- aider --yes-always --message {prompt}
agentflowctl agent set codex --model 你要用的模型 --extra-arg=--search
agentflowctl agent set aider --adapter gemini             # 換 adapter
agentflowctl agent remove aider
agentflowctl agent remove gemini                          # 內建的也能移除
agentflowctl agent cycle claude-strong,codex,gemini       # 不帶參數時顯示目前的順序
```

修改會連帶更新相關設定，並在終端機列出：

- `set --adapter` 換 adapter 時，會清掉舊 adapter 的 `model`、`extraArgs`、`command`，這次有重新指定的除外。
- `remove` 會一併從 `cycle` 移除。`cycle` 變空就刪除這個欄位，改回自動偵測。
- 內建的 claude、codex、gemini 也能 `remove`：覆寫設定會一起刪掉，名稱記在 `removedAgents`，之後自動偵測會跳過它，也不能放進 `cycle`。要加回來用 `agent add gemini --adapter gemini`。
- `--extra-arg` 可以重複指定，會整個取代原本的 `extraArgs`。參數以 `-` 開頭時，寫成 `--extra-arg=--sandbox`。

已建立的 run 會沿用建立時的輪替順序，不受這些修改影響。

## 計畫怎麼在沒有人的情況下通過

人工確認計畫是為了擋住方向錯了還一路做下去。預設用三層機制取代它；加上 `--manual-plan` 時，三層都過了仍會停下來等你。

**格式與覆蓋率。** 每次撰寫或修改計畫之後，都要重新通過 zod、任務相依、無循環、每條驗收條件都有任務負責。沒過就還原。

**跨模型審查。** 審查看需求覆蓋、驗收條件能不能測、任務大小與技術方向。審查者只能寫意見。若改了規格或計畫，檔案會被還原。修改者要在 `plan.md` 的「審查回應」逐條回覆；不同意要寫理由。

**僵持時仲裁。** 兩種情況會觸發：這輪審查意見和上一輪一樣，或已達重試上限。仲裁者只判斷一件事：照這份計畫實作，能不能滿足需求。

| 有幾家 | 誰來仲裁 | 結果 |
| --- | --- | --- |
| 三家以上 | 沒參與這次討論的那一家 | 核准就繼續，否則 run 失敗 |
| 兩家 | 兩家各自在全新 context 裡判斷 | 都核准就繼續；都不核准就停下；分歧依 `tieBreak` |
| 一家 | 同一家 | 由它自己仲裁 |

兩家時的仲裁是雙盲的。仲裁者只看計畫，以及一份不含模型名稱的爭議清單（`.flow/dispute.md`）。帶有名稱的審查紀錄移到 worktree 以外。`tieBreak` 預設 `proceed`，因為後面還有測試紅燈、綠燈、verify 與程式碼審查。

裁決與每位仲裁者的理由附在 `plan.md` 最後的「仲裁紀錄」。原始審查與仲裁紀錄在 `.agentflowctl/runs/<id>/reviews/`。

## 階段與通過條件

| 階段 | 負責的 agent | 程式認定通過的條件 | 失敗時 |
|---|---|---|---|
| spec | 輪替順序第 1 位 | 檔案存在、zod 驗證、id 不重複 | 重試 |
| plan | 輪替順序第 1 位 | zod、相依存在、無循環、每條驗收條件都有任務 | 重試 |
| plan_review | 非計畫作者的下一位（可多位） | 所有審查者都 `approve` | 進入 plan_fix |
| plan_fix | 依 `fixStrategy` | 修改後仍通過 plan 的格式與 DAG 檢查 | 還原並重試 |
| 仲裁 | 見上一節 | 一致核准；分歧依 `tieBreak` | 都不核准，或 `tieBreak: stop` 時 run 失敗 |
| 人工確認 | 你（只有 `--manual-plan`） | `agentflowctl approve` | — |
| implement 紅燈 | 第 i 個任務由第 i 位 | 有測試變更，而且測試執行後失敗 | 還原並重試 |
| implement 綠燈 | 測試作者的下一位 | 測試檔沒有任何修改，而且測試通過 | 還原，或帶著輸出重試 |
| verify | — | `install` 與所有 `checks` 通過 | 交回作者修正 |
| review | 非作者的下一位（可多位） | 所有審查者都 `approve` | 依 `fixStrategy` 交給下一位修正 |
| pr | — | push 成功；有 `gh` 就開 PR | — |

驗收條件寫在 `.flow/acceptance.json`（`AC-1`…），任務寫在 `.flow/tasks.json`（`T-1`…）。

## Prompt 結構

每個階段的 prompt 都有專屬角色：需求分析師、軟體架構師、計畫審查者、計畫修訂者、中立仲裁者、測試工程師、實作工程師、除錯工程師、程式碼審查者。內容用 XML 標籤分段：`<role>`、`<context>`、`<inputs>`、`<steps>`、`<constraints>`、`<output_format>`、`<reply_format>`。

Agent 的最後回覆要附上 XML 中繼資料：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>做了什麼</summary>
  <files_changed><file>src/form.ts</file></files_changed>
  <concerns>對規格或測試的疑慮</concerns>
</result>
```

`blocked` 與 `concerns` 會印在終端機上，完整回覆留在 log。這份中繼資料只給人看；缺少或格式錯誤都不影響流程，是否通過仍由上表的程式檢查決定。

## Adapter

| adapter | 執行方式 | 權限 |
|---|---|---|
| `claude` | `claude -p --output-format stream-json` | acceptEdits、禁止 git 寫入、設定檔在 `.agentflowctl/runs/<id>/claude-settings.json` |
| `codex` | `codex exec --json --sandbox workspace-write`（prompt 走 stdin） | 只能改工作目錄，預設不能連網 |
| `gemini` | `gemini -p --output-format stream-json --approval-mode yolo` | 沒有細緻權限；可在 `extraArgs` 加 `--sandbox`，或放在可丟棄環境 |
| `command` | 任意指令；`{prompt}` 替換，或走 stdin | 取決於該工具 |

Codex 沙箱預設不能連網，所以建立 worktree 時會先跑 `install`。CLI 參數與事件格式更新得很快，第一次使用前先 `doctor`，再用一個小需求實測。

各家讀的專案說明檔不同：Claude Code 讀 `CLAUDE.md`，Codex 讀 `AGENTS.md`，Gemini 讀 `GEMINI.md`。把專案慣例寫在 `AGENTS.md`，另外兩個檔案各用一行引用它。agentflowctl 的 prompt 在 `prompts/`，不依賴任何一家的 skills 或 plugins。

## 登入、額度與代打

只支援各家 CLI 的訂閱登入。

執行 agent 時，一律從子程序環境移除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CODEX_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`，避免環境裡的 key 蓋過訂閱登入。`doctor` 發現這些變數時會提醒。專案指令（install、test、build）不受影響。

上限是執行次數（`maxAgentRuns`，預設 60），不是金額。`status` 會列出各 agent 的執行次數與 token 數。

額度用完時：

| 步驟 | 行為 |
| --- | --- |
| 計畫審查、程式碼審查、仲裁 | 暫停。額度恢復後 `agentflowctl resume`。換人代審會變成作者審自己 |
| 規格、計畫、修改計畫、寫測試、寫實作、修正 | 由輪替順序上下一位還有額度的 agent 代打 |
| 每家都用完 | 暫停 |

換人或暫停前，額度用完的 agent 留下的半成品會先清掉。代打寫在 `.agentflowctl/runs/<id>/substitutions.jsonl`，`status` 會列出。commit 結尾標的是實際執行的模型。

若寫實作的那家額度用完、改由寫測試的那家代打，這個任務的測試與實作就會出自同一家，`status` 會標註。審查步驟仍然暫停，等原本的另一家，因為那是此時剩下的交叉檢查。

額度錯誤靠錯誤訊息辨識（usage limit、rate limit、quota、429 等），只在 agent 執行失敗時判斷。辨識不到時，會當成一般失敗重試。

## 在哪裡跑

agentflowctl 本身只依賴 Node.js 與 git。專案指令透過系統 shell 執行。

| 環境 | 適合的用法 |
|---|---|
| 自己的電腦 | 自己的專案、自己寫的需求。剛開始可以加 `--manual-plan`，確認審查品質後再拿掉 |
| 容器、遠端開發機 | 無人值守。先在該環境內完成各家 CLI 的訂閱登入 |
| Claude Code、Codex 裡面 | 讓它們用 shell 執行 `npx agentflowctl` |

沒有容器隔離時，verify 會在你的電腦上執行 agent 寫出來的程式碼。Gemini 在無人值守時是 yolo 模式。處理外部 issue，或需求文字不是你自己寫的，放到可丟棄的環境。AI 審查計畫擋不住夾在需求裡的指示。

## 專案結構

```
src/
  cli.ts            指令列（run、doctor、status……）
  engine.ts         狀態機與各階段
  roles.ts          輪替規則（含計畫修正者與仲裁者）
  runner.ts         執行 agent、正規化結果、執行專案指令
  logs.ts           log 檔名、檔頭檔尾、列表與解析
  agents/           claude、codex、gemini、command
  git.ts            worktree 與 git 操作
  store.ts          狀態、用量、代打紀錄
  tasks.ts          任務 DAG
  schemas.ts        zod schema
prompts/            各階段 prompt
examples/           flow.config.json 與 GitHub Actions
```

開發：

```bash
pnpm run typecheck
pnpm test
```

## 授權

MIT，詳見 [LICENSE](LICENSE)。
