# agentflowctl 詳細參考

本文件保留完整的指令、設定與流程規則。初次使用請先看 [README](../README.md)，細節見 [執行流程](workflow.md)、[查看進度](monitoring.md)、[設定詳解](configuration.md)；各階段的檔案輸入與產出另見 [各階段檔案](engine-stage-files.md)。

讓 Claude Code、Codex、Gemini CLI（或任何 agent CLI）在同一條流程裡輪流寫規格、寫計畫、寫測試、寫實作、互相審查、互相修正，一路做到開 PR。

```
需求 → spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（每個任務：測試 A → 實作 B → 任務審查 ⇄ 修正 → 任務驗證 ⇄ 修正）→ verify ⇄ fix → review ⇄ fix → pr
```

從需求到 PR 全程由程式推進。每個步驟都是一次獨立的 agent 執行，用 `.flow/` 裡的檔案交接。是否通過一律由程式檢查：跑測試、比對 git diff、驗證 JSON。兩家模型就能完整運作；有第三家時，仲裁會交給沒參與討論的那一家。

## 快速開始

需要 Node.js 22 以上與 git。不需要全域安裝，直接用 `npx` 執行。先讓各家 CLI 完成登入：

```bash
claude    # 完成登入
codex     # 完成登入
```

沒有內建的 agent，只會使用 `flow.config.json` 的 `agents` 裡設定的。用 `agent setup` 互動設定：它會先列出已設定的 agent 與 CLI 是否可以執行，再偵測本機裝了哪些支援的 CLI（目前是 `claude`、`codex`、`gemini`），只針對已安裝的逐一詢問要不要加入、名稱與 model，再設定參與的 agent；沒偵測到的只列出、不詢問。確認後才一次寫入，最後自動跑一次 `doctor`：

```bash
npx agentflowctl agent setup
```

也可以不經互動，直接用指令新增：

```bash
npx agentflowctl agent add claude --adapter claude
npx agentflowctl agent add codex --adapter codex
```

之後改了設定或換了環境，用 `doctor` 檢查。它會列出設定的 agent 的 CLI 是否已安裝，並印出即將參與的 agent。沒有設定 `cycle` 時，依 `agents` 的順序取已安裝的；一個都沒偵測到就無法執行。

```bash
npx agentflowctl doctor
```

從舊版升級：以前沒寫 `agents` 時會自動使用內建的 claude、codex、gemini，現在不會了，要先用 `agent setup` 或 `agent add` 補上。舊設定裡的 `removedAgents` 已不再使用，可以刪掉。

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

## 角色分配怎麼打破同溫層

同一個模型審查自己的程式碼，容易放過自己的寫法；測試和實作出自同一個模型，也容易寫出剛好會過的測試。角色分配只有四條規則，定義在 `src/roles.ts`：

| 規則 | 效果 |
|---|---|
| 審查者永遠不是最後寫程式的 agent，多位審查者彼此不重複 | 每一輪審查都由另一家看 |
| 同一個任務的測試與實作由不同 agent 負責（`tddSplit`） | A 寫的測試，B 實作到通過，而且不能改測試 |
| 人選隨機決定，不依 `cycle` 的順序 | 各家輪流當作者、審查者、修正者，不會固定由同一家起頭 |
| 任務的測試、實作、任務審查輪流交換 | 各家用量平均，不會固定由同一家寫實作 |

`cycle` 只決定哪些 agent 參與。隨機以 run id 為種子，同一個 run 的同一步驟 `resume` 後仍是同一家。任務的角色依同一個隨機順序輪流交換：第 i 個任務由順序中的第 i 家寫測試、下一家寫實作、再下一家做任務審查。三家時每三個任務各家把三種角色各做一次；兩家時測試與實作每個任務互換，任務審查由該任務的測試作者負責。任務修正後重新審查，仍優先由同一位審查者審查。

兩家時是乒乓，例如：

```
計畫：codex 撰寫 → claude 審查（要求修改）→ codex 修改 → claude 審查（核准）
T-1  測試：claude   實作：codex    任務審查：claude
T-2  測試：codex    實作：claude   任務審查：codex
審查：codex（最後作者是 claude）→ 要求修改 → claude 修正 → codex 審查（核准）
```

三家時，任務依輪替分工，例如 T-1 由 claude 測試、codex 實作、gemini 審查，T-2 就是 codex、gemini、claude；程式碼審查的審查者從作者以外隨機挑，修正者從審查者以外隨機挑；仲裁交給沒寫過這份計畫、也沒審過它的那一家（有多家時隨機挑一家）。

每個 commit 訊息結尾會標上實際作者，例如 `feat(T-2): 匯出 [gemini]`。

只裝一家也能跑完，只是審查、測試、實作都會落在同一家。

## 指令

```bash
agentflowctl run --req "..."
agentflowctl run --req-file ./req.md --cycle codex,claude --max-agent-runs 40
agentflowctl run --req "..." --manual-plan   # 計畫通過 AI 審查後，仍停下來等你確認
agentflowctl run --req "..." --stop-after plan   # 完成計畫審查後暫停，檢視產出再 resume

agentflowctl approve f-xxxx        # 搭配 --manual-plan
agentflowctl status f-xxxx         # 階段、上一步結果、未結交接事項、下一步指令、任務進度、待你確認、各 agent 用量、代打紀錄、重試紀錄
agentflowctl confirmations f-xxxx  # 只列出需要人眼確認的任務
agentflowctl insights              # 所有 run 的結果、失敗原因、用量、模型×步驟、步驟失敗、重試原因與建議
agentflowctl list
agentflowctl logs f-xxxx           # 列出每一份 log 的編號、結果、階段、步驟、agent
agentflowctl logs f-xxxx 7         # 解析第 7 份 log，最後附上錯誤整理（--latest 看最新一份）
agentflowctl logs f-xxxx 7 --full  # 逐條顯示 shell 指令，完整顯示多行內容與絕對路徑
agentflowctl logs f-xxxx 7 --raw   # 原始內容（agent 的 JSON 行）
agentflowctl resume f-xxxx         # 從暫停、Ctrl-C 或失敗處接續
agentflowctl cancel f-xxxx
agentflowctl clean f-xxxx          # 移除 worktree 與 run 紀錄，分支保留
agentflowctl clean --all           # 清掉所有已結束的 run 與中斷留下的 worktree
```

| 選項 | 作用 |
|---|---|
| `--req` / `--req-file` | 需求文字，或從檔案讀取 |
| `--base` | 基底分支，預設為目前分支 |
| `--cycle` | 這次 run 參與的 agent，例如 `claude,codex,gemini`；順序不影響分工；建立後就固定，`resume` 沿用 |
| `--max-agent-runs` | 這次 run 的 agent 執行次數上限 |
| `--fast` | 快速流程：一次 agent 呼叫寫完規格與計畫（任務最多 2 個）、略過計畫審查與任務審查；計畫標出複雜度時改走完整流程。見[執行流程細節](workflow.md#快速流程--fast) |
| `--manual-plan` | 計畫通過審查後進入 `awaiting_approval`，等 `approve` 才開始實作 |
| `--stop-after <階段>` | 完成 `spec`、`plan`、`implement`、`verify` 或 `review` 後進入 `paused`，用 `resume` 接續；`pr` 照常完成。與 `--manual-plan` 互斥，`resume` 不能更改停點 |
| `-v` / `--verbose` | 執行時印出 agent 的文字、工具呼叫與專案指令；`run`、`resume`、`approve` 都適用，也可在 `flow.config.json` 設 `"verbose": true` |

`status` 會列出任務，並把需要人眼確認的項目放在另一個「待你確認」區塊。進行中的實作任務會標出目前的步驟：🧪 寫測試、🛠️ 寫實作、👀 任務審查、🔍 任務驗證、🩹 任務修正。`confirmations <id>` 只印「待你確認」，沒有時會說明沒有。

### 清除 worktree

`run` 建好 worktree 就會寫入 run 紀錄，所以不論在哪一步中斷（包括安裝相依套件時），都能用 `resume` 接續，或用 `clean` 清掉。

- `clean <id>`：移除該 run 的 worktree 與 `.agentflowctl/runs/<id>/`，並清掉 git 裡已失效的 worktree 登記。沒有 run 紀錄的 worktree 也能清，worktree 資料夾被手動刪掉時也一樣。
- `clean --all`：清掉所有 `done`、`failed` 的 run，以及沒有 run 紀錄的 worktree。進行中、`paused`、`awaiting_approval` 的不動；Ctrl-C 中斷、之後不打算接續的 run，先 `cancel` 再 `clean --all`，或直接 `clean <id>`。

兩者都保留 `flow/<id>` 分支，不需要時用 `git branch -D` 刪除。

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

`agentflowctl logs <id>` 列出所有 log。結果欄的 ✓ 是成功，✗ 是失敗，… 代表沒有結束紀錄：

```
  #  結果  階段          步驟                 agent       開始時間
  1  ✓     setup         install              cmd         2026-09-26 11:29:04
  2  ✓     spec          spec                 claude      2026-09-26 11:29:05
  3  ✗     plan          plan                 codex       2026-09-26 11:31:40
```

`agentflowctl logs <id> <編號>` 會把原始 JSON 解析成易讀的格式：

| 標記 | 內容 |
|---|---|
| 💬 | agent 的完整文字，不截斷 |
| 🔧 | 工具呼叫。連續的 shell 指令（多半是讀檔、搜尋）收成一行 `🔧 shell 指令 ×N`；其他工具只顯示第一行，多行時註明共幾行，worktree 內的絕對路徑改成相對路徑 |
| 📊 | token 用量 |
| 🏁 | 最後結果。與最後一則 💬 相同時不再重印 |
| ⚠️ | 工具回報的錯誤。agent 通常會自己換方法繼續，所以不列進錯誤整理 |
| ❌ | adapter 不認得的錯誤事件 |
| 📄 | 不是 JSON 的輸出行 |

要逐條看 shell 指令、完整的工具內容與重複的最後結果，加 `--full`。adapter 不認得、也看不出錯誤跡象的 JSON 行不會顯示，只列出行數，要看全部請加 `--raw`。專案指令的 log 本來就是純文字，會原樣顯示。

最後一段「錯誤」整理出結束碼、agent 回報的失敗、錯誤事件與 stderr：

```
#3  plan / plan / codex
開始 2026-09-26 11:31:40　結束 2026-09-26 11:31:52　結束碼 1　✗ 失敗
檔案 /repo/.agentflowctl/runs/f-xxxx/logs/003-plan-plan-codex.log

💬 先讀 spec.md 與 acceptance.json
🔧 shell 指令 ×1（--full 查看）
🏁 失敗：stream disconnected before completion

── 錯誤 ──
結束碼 1
agent 回報失敗：stream disconnected before completion
stderr：
   Error: stream disconnected before completion
```

執行成功時，stderr 會放在「其他輸出」段落，不算錯誤。

### 重試紀錄

關卡沒通過而重試時，原因代碼 append 到 `.agentflowctl/runs/<id>/retries.jsonl`，與 log、用量放在同一份執行紀錄裡。每筆紀錄包含關卡 `key`、退回的階段 `backTo`、分類 `category`、第幾次 `attempt`，以及是否達上限 `final`。`insights` 彙總所有 run 的最終狀態與這些原因；`status <id>` 列出該 run 的明細。舊 run 沒有這份檔案，不會回填。分類由程式在重試當下寫入，不從 `feedback.md` 的文字回推。

- 任務關卡的 key 帶有 task id（例如 `T1:tests`）。`insights` 的「最常重試的關卡」會去掉 task id，合併成 `任務:tests` 這類關卡；`status <id>` 仍顯示原本的 key。
- 寫入重試紀錄之後、存回 `state.json` 之前若被中斷，resume 重跑同一步時不會重複記錄。
- 寫到一半的殘行會被略過，不影響 `status` 與 `insights`。

| category | 顯示 | 呼叫點 |
|---|---|---|
| `agent_error` | Agent 執行失敗 | `!r.ok` |
| `missing_artifact` | 缺少必要檔案 | 缺少 `.flow/spec.md`（spec 階段直接檢查） |
| `format_invalid` | 輸出格式錯誤 | zod／驗收 id 重複／`validatePlan` 字串（缺少 `plan.md`，以及格式與 DAG 錯誤） |
| `handoff_invalid` | 交接回覆不合格 | `finishHandoff` 回傳錯誤 |
| `open_handoff` | 未結交接事項 | `planSettled` 的未結 action |
| `review_changes` | 審查要求修改 | 計畫／任務／整體審查 `changes_requested` |
| `arbitration_revise` | 仲裁要求修訂 | 兩家雙盲仲裁都不核准，退回 plan_fix（不計入重試上限） |
| `plan_tampered` | 改動已鎖定的計畫檔 | `planTamperedMessage` |
| `tests_not_written` | 未寫測試 | 無 commit、或沒改測試檔 |
| `code_not_written` | 未實作 | 舊版：略過 TDD 的實作沒有 commit 時重試。現在沒有檔案變更會略過該任務，不再寫入這個分類 |
| `tests_not_red` | 紅燈測試未失敗 | 實作前測試就全過 |
| `tests_modified` | 實作改了測試 | 綠燈階段動到測試檔 |
| `checks_weakened` | 繞過檢查 | 修正或實作新增了 `skip`／`only`／`todo`、`@ts-ignore`、`@ts-nocheck`、`eslint-disable`，或修正讓測試檔的斷言變少 |
| `tests_not_green` | 測試仍未通過 | 實作後測試失敗 |
| `tests_deleted` | 刪除測試檔 | fix 刪測試 |
| `merge_tests_failed` | 平行任務合併後測試失敗 | 車道合併回 run 分支後全套測試未通過（沒有文字衝突的語意衝突），還原合併並讓車道重做 |
| `checks_failed` | 專案檢查失敗 | `runChecks` 有失敗（原樣重跑一次仍失敗才算，見 `rerunFailedChecks`） |

run 失敗時，`state.json` 另外記錄 `failureCategory`，`insights` 依此列出「失敗原因」。關卡重試達上限只是其中一種，其他失敗不會出現在 `retries.jsonl`：

| failureCategory | 顯示 | 情況 |
|---|---|---|
| `retry_limit` | 關卡重試達上限 | `retries.jsonl` 最後一筆 `final: true` |
| `arbitration_stop` | 仲裁停止 | 第三方仲裁不核准，或雙盲仲裁意見分歧且 `tieBreak=stop` |
| `open_handoff` | PR 前仍有未結事項 | pr 階段仍有未結交接事項 |
| `agent_budget` | agent 次數用完 | 達到 `--max-agent-runs` |
| `error` | 執行時發生錯誤 | 階段丟出例外 |
| `cancelled` | 使用者取消 | `agentflowctl cancel` |

舊 run 沒有這個欄位，在 `insights` 列為「未分類（舊 run）」。

### 停下來時的結果與下一步

run 因 Ctrl-C、失敗、額度暫停或等待核准而停下時，終端機會直接印出三段；`agentflowctl status <id>` 也會印同樣的內容：

- **結果**：被中斷、還沒有結束紀錄的步驟，以及上一步的結果。agent 的步驟取回覆 `<result>` 的摘要與疑慮；失敗時優先顯示失敗的那一步，並附上結束碼、錯誤事件、stderr 或指令輸出的最後幾行。
- **未結交接事項**：交接紀錄裡還沒結案的 action 事項（open 或 proposed_resolved）。
- **下一步**：依狀態列出可以執行的指令，例如 `logs`、`cd` 到 worktree、`resume`、`cancel`、`approve`。

```
── 結果 ──
  中斷於 #20 plan_review / plan-review / codex（沒有結束紀錄，resume 時會重跑這一步）
  #19 plan_fix / plan-fix / claude ✓
     摘要：接受三條審查意見，拆分 T-3、T-5
     疑慮：T-15 可能仍太大

── 未結交接事項 ──
  [plan] c9c730b280e87178 T-3、T-5 各混合多個獨立行為（proposed_resolved）

── 下一步 ──
  agentflowctl logs f-xxxx 19              看上一步的完整 log
  agentflowctl resume f-xxxx               從 plan_review 接續
  agentflowctl cancel f-xxxx               放棄這個 run
```

### 出錯時怎麼查

1. 先看 run 停下時印出的「結果」與「下一步」，或執行 `agentflowctl status <id>`。
2. `agentflowctl logs <id> <編號>` 看那份 log 的錯誤段落。
3. 解析結果看不出原因時，加 `--raw` 看原始輸出。
4. 必要時直接在 worktree（`.agentflowctl/worktrees/<id>`）裡修正，再執行 `agentflowctl resume <id>`。

## 設定

專案根目錄的 `flow.config.json`。完整範例見 `examples/flow.config.json`。未提供的欄位使用內建預設；`install`、`test`、`checks` 沒寫時，會依專案現況偵測（見下方「專案指令的偵測」）。

```json
{
  "cycle": ["claude", "codex"],
  "fixStrategy": "ring",
  "tddSplit": true,
  "tieBreak": "proceed",
  "defaultModels": { "claude": "Claude 模型名稱", "codex": "Codex 模型名稱", "gemini": "Gemini 模型名稱" },
  "agents": {
    "claude": { "adapter": "claude" },
    "codex": { "adapter": "codex", "model": "你要用的模型" },
    "aider": { "adapter": "command", "command": ["aider", "--yes-always", "--no-auto-commits", "--message", "{prompt}"] }
  }
}
```

| 設定 | 預設 | 說明 |
|---|---|---|
| `cycle` | 自動偵測 | 參與的 agent，順序不影響分工（人選隨機決定）。未設定時依 `agents` 的順序取已安裝的 CLI。同一家 CLI 可以登記成不同 agent，例如 `claude-fast` 與 `claude-strong` |
| `defaultModels` | `{}` | 依 `claude`、`codex`、`gemini` adapter 指定全域預設 model；agent 的 `model` 優先，兩者都沒設時使用各 CLI 的預設。`command` adapter 不套用 |
| `fixStrategy` | `ring` | `ring`：審查意見隨機交給審查者以外的一家；`author`：交回最後作者 |
| `tddSplit` | `true` | 測試與實作是否分開 |
| `reviewQuorum` | `1` | 程式碼需要幾位不同審查者都 `approve`（任務審查與最後的程式碼審查都適用）。預設只有一位，單一模型的盲點就是最後一道關卡；重要專案建議設 `2` 以上，代價是每次審查多花一次 agent 呼叫 |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者都 `approve` |
| `planArbiter` | `true` | 計畫審查僵持，或第 2 輪（修訂過一次）仍有人要求修改時交付仲裁，不等到重試上限。關掉之後，僵持時照常退回修訂，要求修改的審查輪數達到 `maxAttempts` 時 run 失敗（重試達上限） |
| `planReviewLayers` | `{ "enabled": true, "minTasks": 7, "maxGroups": 5, "tasksPerGroup": 3 }` | 計畫分層審查（見「計畫」一節）。`enabled`：`false` 時一律整份審查；`minTasks`：任務數達到這個值才考慮分層，整數至少 2；`maxGroups`：每輪最多幾群，整數至少 2；`tasksPerGroup`：群數也不超過任務數除以這個值（無條件捨去），整數至少 1。子欄位都可省略；寫了未知子欄位會驗證失敗 |
| `tieBreak` | `proceed` | 兩家仲裁意見分歧時：`proceed` 繼續，沒核准的那一方的每則意見另記成程式碼類的待處理事項（`action`），最終審查必須結案或明確接受，否則不能開 PR；`stop` 停下 |
| `maxAgentRuns` | `60` | 單一 run 最多執行幾次 agent |
| `maxAttempts` | `5` | 同一關連續失敗幾次後停止，至少 3 |
| `verbose` | `false` | 顯示 agent 文字、工具呼叫與專案指令，效果同 `-v` |
| `install` / `test` / `checks` | 依專案偵測 | 安裝、測試與 verify 階段實際執行的指令 |
| `testPattern` | `\\.(test\|spec)\\.[cm]?[jt]sx?$` | 用來辨識測試檔的正規表示式；測試檔命名不同時需調整 |
| `agents` | `{}` | 可用的 agent，沒有內建的。每個都要指定 adapter（`claude`、`codex`、`gemini`，或用 `command` 接上其他 CLI） |

verify 失敗（型別、lint、建置）一律交回最後作者。審查意見才依 `fixStrategy` 決定修正者。

`maxAttempts`（寫在 `flow.config.json`）是同一關連續失敗的上限，預設 5，至少 3（設定檔或 `--max-attempts` 小於 3 都會報錯）；可用 `run --max-attempts`／`resume <id> --max-attempts` 針對單一 run 覆蓋。`verbose` 為 `true` 等同執行時加 `-v`。agentflowctl 不讀取任何 `AGENTFLOWCTL_*` 環境變數。

### 專案指令的偵測

`install`、`test`、`checks` 沒寫在 `flow.config.json` 時，每次讀設定都會依專案現況推出指令，不寫檔。有寫的欄位一律照你的設定。

- 套件管理器：先看 `package.json` 的 `packageManager`，再看 lockfile（`pnpm-lock.yaml`、`yarn.lock`、`bun.lock`／`bun.lockb`、`package-lock.json`），都沒有就用 npm。
- `install`：`pnpm install`、`yarn install`、`bun install` 或 `npm install --no-audit --no-fund`。不鎖 lockfile，因為實作時 agent 可能新增依賴。
- `checks`：typecheck、lint、test、build 四項。`package.json` 有對應的 script（`typecheck`／`type-check`、`lint`、`test`、`build`）就用 `<pm> run <script>`，否則用 `tsc --noEmit`、`eslint .`、`vitest run`、`vite build`，前面加上 `npx`、`pnpm exec`、`yarn` 或 `bunx`。沒有 lint 或 typecheck script 就略過該項，不退回預設指令。
- `lint` script 含 `eslint` 時，指令列加上 `--ignore-pattern`，略過 `.flow/**`、`.agentflowctl/**`、`.worktree/**`、`.worktrees/**`。不是 eslint（例如 biome）則不改指令。`changedOnly` 交給 lint 的檔案清單也會拿掉這四個目錄。
- `test`：預設是 `vitest run`，並附加 `--exclude '**/.worktree/**' --exclude '**/.worktrees/**'`。這個 `--exclude` 加在專案 vitest 設定與內建 exclude 之後，不會拿掉 `node_modules`。`test` script 的內容含 `vitest` 時同樣附加；其他測試指令不改。
- 型別檢查（`tsc`）與 `vite build` 不加目錄排除：`tsc` 沒有這種參數，也不改寫專案 tsconfig；vite 無法在不改設定檔時排除目錄。
- 測試框架：`package.json` 的 `dependencies`／`devDependencies` 有 `vitest`、`jest`、`mocha`、`ava`、`jasmine`、`tap`、`uvu`、`@playwright/test`、`cypress` 之一，或 `test` script 存在且不是 `npm init` 的佔位（`no test specified`），就算有測試框架；在 `flow.config.json` 手動設定 `test` 也算。沒有測試框架時：所有任務略過紅綠燈（見「任務的 `tdd` 標記」），預設 `checks` 不含 `test`，`run` 會印出「未偵測到測試框架」。手動設定的 `checks` 一律照設定。

`run` 建立 worktree 後會印出這次偵測到的指令：

```
[f-xxxx] 🔧 依專案偵測指令：pnpm（依 package.json 的 packageManager）
[f-xxxx]    install：pnpm install
[f-xxxx]    checks.typecheck：pnpm run type-check
```

### 任務的 `tdd` 標記

計畫 agent 會依改動內容在 `tasks.json` 的每個任務寫 `tdd`（選填，沒寫視為 `true`）。`false` 表示這個任務不適合先寫會失敗的測試，例如建置流程與打包設定、依賴與版本設定、文件與 prompt 文字、樣式、型別宣告、不改變行為的重構，以及鎖定既有行為、實作前就會通過的特徵化測試。描述寫了「不要求紅燈」「不必紅燈」「略過紅燈」或「略過紅綠燈」，但 `tdd` 不是 `false` 時，計畫驗證直接退回（`format_invalid`），要求改成 `false`。分層審查只在描述補註、卻沒改 `tdd`，仍須要求修改。已定案的計畫若仍衝突，執行到該任務時仍撰寫測試；測試一開始就通過也進入綠燈，不記 `tests_not_red`，任務審查也不因這項衝突要求修改。`tdd` 的變更會計入任務指紋，該任務所在的群會重審。計畫要寫明理由與驗收方式，計畫審查會核對，會改變程式行為卻標成 `false` 的要求改回。實際是否走 TDD 由程式決定：`專案有測試框架且 tdd 不是 false` 才走紅綠燈。

略過 TDD 的任務：

- 不做紅燈；進入實作時記下當下的 HEAD 作為任務起點（`taskBase`），實作用 `prompts/implement-direct.md`，沒有 `red-output.txt`。
- 有檔案變更才 commit，接著跑既有測試（有測試框架時）並進入任務審查。沒有檔案變更就略過這個任務，不重試、也不要求硬做出一個 commit。
- 有測試框架時，有變更的實作仍會跑 `test` 指令，確認既有測試沒被破壞；沒有測試框架時不跑。實作階段不檢查有沒有動到測試檔。
- 有變更時之後照常：任務審查、驗證（`checks`）、任務修正。

`run` 印出任務清單時，略過 TDD 的任務會顯示「略過 TDD」取代測試 agent。

### 需要人確認的任務

任務可以標 `"kind": "confirm"`（沒寫視為要實作）。這類事項程式無法用檔案或指令判定，例如要人眼看過的結果。計畫定案時會從 `tasks.ordered.json` 拿掉，寫進 `.flow/confirmations.json`。實作不會做到它們，run 也不會因此停下。`status <id>` 在「任務」區塊之外另列「待你確認」。`confirmations <id>` 只列出這個區塊。若進行中的舊清單裡還留著這種任務，執行到它時同樣搬過去，然後繼續下一個實作任務。

### 用指令管理 agent

`agents` 與 `cycle` 也可以用 `agent` 指令修改，不必手動編輯 JSON。每次寫入前都會先驗證整份設定：

```bash
agentflowctl agent setup                                  # 偵測已安裝的 agent CLI，互動設定與參與的 agent
agentflowctl agent list                                   # 設定的 agent、是否已安裝、是否參與
agentflowctl agent add claude-strong --adapter claude --model opus
agentflowctl agent add aider --adapter command -- aider --yes-always --message {prompt}
agentflowctl agent set codex --model 你要用的模型 --extra-arg=--search
agentflowctl agent set aider --adapter gemini             # 換 adapter
agentflowctl agent remove aider
agentflowctl agent cycle claude-strong,codex,gemini       # 不帶參數時顯示目前參與的 agent
```

修改會連帶更新相關設定，並在終端機列出：

- `set --adapter` 換 adapter 時，會清掉舊 adapter 的 `model`、`models`、`modelProbe`、`extraArgs`、`command`，這次有重新指定的除外。同一 adapter 的 `agent set` 只改指定欄位，不會覆寫既有 `models`；`model add/set/remove` 也只改指定 agent 的模型清單。
- `remove` 會一併從 `cycle` 移除。`cycle` 變空就刪除這個欄位，改回從 `agents` 自動偵測。
- `--extra-arg` 可以重複指定，會整個取代原本的 `extraArgs`。參數以 `-` 開頭時，寫成 `--extra-arg=--sandbox`。
- `setup` 只詢問偵測到已安裝的 CLI，一個都沒有就不變更設定。遇到已存在的名稱會先問要不要覆寫；不覆寫時保留原設定，但仍會參與。在非互動式環境（CI、管線）裡請改用 `agent add`。`command` adapter 要自己寫指令，不在 `setup` 裡。

已建立的 run 會沿用建立時參與的 agent，不受這些修改影響。

## 模型設定與自動選模

`modelSelection.mode` 預設為 `balanced`，沿用 `agents.<名稱>.model`、`defaultModels` 與 CLI 預設。`adaptive` 只看該 agent 的 `models` 清單與 `modelSelection.stageStrength`；舊欄位不作後備。`run --model-mode balanced|adaptive` 只覆蓋新 run，模式存在 `state.json`，`resume` 不改變模式。已建立的 run 在每次 LLM 呼叫前重新讀取模型清單與階段強度，因此設定變更會影響後續呼叫。

```json
{
  "agents": {
    "claude": {
      "adapter": "claude",
      "models": [
        { "name": "請用 model add 登記目前可呼叫的名稱", "strength": "low" }
      ]
    }
  },
  "modelSelection": {
    "mode": "adaptive",
    "stageStrength": { "taskReview": "high" }
  }
}
```

上例只說明欄位形狀，並非可直接呼叫的模型設定。建議用指令管理：

```bash
agentflowctl model add claude MODEL_NAME --strength low
agentflowctl model set claude MODEL_NAME --strength medium
agentflowctl model remove claude MODEL_NAME
agentflowctl model list
agentflowctl model check
agentflowctl model mode adaptive
agentflowctl model stage taskReview high
```

`name` 接受 CLI 的別名或完整 ID；`model add` 以當前登入帳號送出短請求，成功後才寫設定，可能耗用少量 token。`model set` 只改強度，不重驗；`model check` 重驗已登記模型，並顯示檢查時間。檢查結果只適用於當下帳號與 CLI 狀態，不保證往後的額度或權限。手動編輯 JSON 不會得到可用性驗證。`model mode adaptive` 與移除最後一個模型的 `model remove` 會檢查參與者有模型清單，缺少時列出所有缺模型的 agent；此移除檢查不受目前模型模式影響。有設定 `cycle` 時檢查其中的 agent，否則檢查全部已設定的 agent。`run` 另會在建立 worktree 前檢查本次實際參與者、模型參數衝突與自訂命令占位符，`resume` 接續 adaptive run 前也會重做這項檢查。`model stage` 不帶強度時列出各階段實際生效的強度，並標示是預設或自訂。

| 階段鍵 | LLM 步驟 | 預設強度 |
| --- | --- | --- |
| `spec` | 寫規格 | medium |
| `plan` | 拆任務 | high |
| `planReview` | 計畫審查 | high |
| `planFix` | 修改計畫 | medium |
| `planArbiter` | 仲裁 | high |
| `taskTests` | 任務寫測試 | low |
| `taskCode` | 任務實作 | low |
| `taskReview` | 任務審查 | medium |
| `taskFix` | 任務修正 | low |
| `fix` | 整體修正 | medium |
| `review` | 整體審查 | high |

計畫 agent 會在 `tasks.json` 為每個 task 寫 `complexity: low|medium|high`，並在 `plan.md` 逐項記錄影響範圍、技術不確定性與失敗後果的判定依據，取三者最高等級；計畫審查 agent 會對照程式碼獨立核對。`low` 是沿用既有做法且影響侷限、容易局部驗證；`medium` 涉及多模組或介面協調、非典型邊界、相容性或狀態遷移風險；`high` 涉及跨系統契約、架構或資料模型變更、未知的關鍵技術路徑，或資料遺失、權限、難以回復的風險。檔案數、行數與驗收條件數不能單獨決定難度。這項語意判斷由 agent 審查；程式關卡檢查 `complexity` 欄位是否合法及是否存在。`adaptive` 計畫缺少此欄位時重試，舊 run 缺少時選模視為 medium。任務相關步驟的基準強度取階段強度與任務難度較高者；其他步驟取階段強度。從已分配角色的 agent 清單選足夠且最低強度的模型，同強度按清單順序；沒有足夠強度時用它最強的模型並提示。模型選擇不更改測試、實作、審查與作者修正的分工。

同一步執行失敗會逐級升強度，最多到 high。審查要求修改本身不讓審查升級；修正後仍未通過才讓修正升級。計畫與整體審查小組只升級失敗的審查者，成功者下次仍從基準強度開始；分層計畫審查的任務群依群分開計算，一群失敗不會讓同一位審查者在其他群也升級。額度用完沿用原政策：審查暫停，寫入工作可由另一位有額度的 agent 代打，並從代打者自己的清單重新選模。

終端機每次呼叫都顯示送給 CLI 的模型名稱；Claude Code 與 Gemini CLI 在初始化事件回報實際模型，與送出名稱不同時完成後顯示 `↳ CLI 回報實際模型：…`。Codex CLI 只在模型被改派時回報實際模型（`model rerouted: A -> B`），其餘情況別名沒有 CLI 的實際模型回報，不推測解析結果。`status` 按階段、任務、模型與步驟、強度顯示呼叫和 token：階段用量以上表的階段鍵加總所有任務的同一步，認不得的舊步驟歸為「其他」；任務用量加總該任務的寫測試、實作、任務審查與任務修正，規格、計畫、整體驗證修正與整體審查歸為「非任務步驟」。只有明確回報的 token 納入合計與占比。沒有 usage 事件顯示「未回報」，舊紀錄因無法分辨真實 0 與補值而顯示「回報狀態不明」，各 agent 用量另列其原始數字供查閱，不算進合計與占比。

`insights` 跨 run 讀 `costs.jsonl`、各 run 的 log（讀整份檔案再取檔頭檔尾，run 多時會比較慢）、`retries.jsonl` 與 `failureCategory`，分區塊列印，並依固定門檻列出最多五則建議。各 agent、階段、模型×步驟、模型強度是同一批呼叫的不同切片，不要跨組相加。模型×步驟只印 tokens 最高的 10 列。task id 只在同一個 run 內有意義：模型×步驟用步驟種類（`small / taskCode`），步驟執行與失敗把 `T-1-green` 合併成 `任務:green` 並依失敗次數排序；用量最高的任務只在各 run 那一列列出。不把 `model add/check` 探測算進去。不印跨 run 總經過時間。殘行略過也涵蓋 `costs.jsonl`。

| code | 顯示 | 觸發條件 |
|---|---|---|
| `coverage_low` | 用量回報不完整 | `runs >= 5` 且 `(unreportedRuns + legacyRuns) / runs >= 0.3` |
| `high_strength_share` | 高強度模型占比偏高 | `total.tokens > 0` 且 `high.tokens / total.tokens >= 0.4` |
| `retry_waste` | 重試可能比單次 prompt 更耗 token | 跨 run 重試筆數 `>= 2`，不含 `review_changes` 與 `arbitration_revise` |
| `input_heavy` | 輸入遠大於輸出 | `total.tokens >= 5000` 且 `inputTokens / tokens >= 0.85` |
| `hot_stage` | 單一階段佔用量過高 | 至少兩個階段 `tokens > 0`，最高階段 `>= 35%` |
| `hot_task` | 單一任務佔用量過高 | 逐 run 判斷：排除「非任務步驟」後至少兩個任務 `tokens > 0`，最高任務佔該 run 任務合計 `>= 40%`；多個 run 符合時取 tokens 最高的 |
| `substitution_waste` | 額度代打造成重做 | 跨 run 代打次數 `>= 2` |
| `cache_unread` | cache 寫入多、讀取少 | `cacheWriteTokens >= 1000` 且 `cacheReadTokens < cacheWriteTokens * 0.5` |
| `hot_model_step` | 單一模型與步驟佔用量過高 | 至少兩個「模型 / 步驟種類」`tokens > 0`，最高列佔合計 `>= 35%` |
| `hot_failing_step` | 單一執行步驟失敗次數過多 | 合併後有步驟 `failed >= 3`：先取失敗最多的 agent 步驟，沒有才取 cmd |
| `fragmented_tasks` | 任務可能切太碎 | 逐 run 判斷：排除「非任務步驟」後至少 6 個任務 `tokens > 0`，且平均每任務輸出 `< 6000` tokens；多個 run 符合時取任務用量最高的。影響估為任務用量的 20%。門檻是猜的，尚未用實際 run 校準 |

`model add/check` 對 Claude Code、Codex 與 Gemini CLI 明確指定模型，在獨立暫存目錄送出短請求，不沿用正常工作的 `extraArgs`，30 秒逾時；macOS／Linux 逾時或 Ctrl-C 中斷時會停止整個程序群組，包含 CLI 啟動的子程序。成功必須同時有文字、成功完成事件與零工具事件；任何失敗事件都會使探測失敗，即使後來又回報成功也一樣。Codex 的 `error` item 依 Codex CLI 定義是非致命通知（設定警告、棄用提示、找不到模型 metadata、模型改派），只顯示為警告，不影響探測與 run 結果；真正的失敗是 `turn.failed` 與頂層 `error` 事件。CLI 不支援探測參數或 Gemini 未載入工具限制時直接失敗，不會用更寬鬆權限重試；失敗不新增模型，`model check` 不修改設定。

| CLI | 探測限制 |
|---|---|
| Claude Code | `--tools ""`、`--strict-mcp-config`、停用 slash commands |
| Codex | `read-only` 沙箱、`approval_policy="never"`；忽略使用者設定與 rules、停用 shell、hooks、apps、plugins、瀏覽器、電腦控制、圖像、子 agent 等功能。仍可能有模型內建檔案工具，寫入由唯讀沙箱阻擋，工具事件使驗證失敗。未回報實際模型 ID 時不推測別名解析結果 |
| Gemini CLI | admin/user deny policy（`toolName="*"`、`priority=999`，合法範圍 0–999）、default approval、停用 extensions、MCP 與 hooks；政策載入警告或錯誤使驗證失敗 |

探測參數以 Codex CLI 0.157.1 與 Gemini CLI 0.61.0 查核；較舊版本若不支援參數，請更新 CLI。登入資訊仍由各 CLI 使用目前帳號讀取，探測可能耗用少量 token，且不屬於 run 用量。

自訂 `command` adapter 若要參與 `adaptive`，執行指令須含 `{model}`，還需以可重複的 `agent set NAME --model-probe-arg=ARG` 設定 `modelProbe` 命令陣列。第一個值是執行檔，命令必須含 `{model}`，並輸出單一 JSON 物件：`{"requestedModel":"輸入名稱","resolvedModel":"實際模型 ID"}`。agentflowctl 會核對格式與名稱；底層服務是否真的被呼叫，仍由這支自訂探測命令負責。

## 計畫怎麼在沒有人的情況下通過

人工確認計畫是為了擋住方向錯了還一路做下去。預設用三層機制取代它；加上 `--manual-plan` 時，三層都過了仍會停下來等你。

**格式與覆蓋率。** 每次撰寫或修改計畫之後，都要重新通過 zod、任務相依、無循環、每條驗收條件都有任務負責，而且每個任務最多對應四條驗收條件、每條驗收條件只能由一個實作任務負責（`kind: confirm` 除外；想補強既有行為就併回原任務）。`taskConcurrency` 不是 1 時還要檢查平行任務：兩個沒有相依關係（任一方向的相依鏈都連不到對方）的任務，不可以在描述裡寫同一個檔案、或一個寫的檔案在另一個寫的目錄底下，否則合併時才衝突、整條車道重做，退回計畫要求用 `dependsOn` 排出先後或合併任務。沒過就還原。

**跨模型審查。** 審查看需求覆蓋、驗收條件能不能測且一條只寫一個行為、任務是否只做一件事（最多四條驗收條件、相同驗收條件的任務要合併）與技術方向。審查者只能寫意見。若改了規格、計畫或審查回應，檔案會被還原。修改者要在 `.flow/plan-replies.md` 逐條回覆審查意見，不同意要寫理由；這份檔每輪覆寫，不寫進 `plan.md` 文末。下一輪索引會看到整份回應；任務群只看到自己的 `## T-<數字>` 節。

計畫審查先核對需求與四份計畫交接檔，再查閱任務說明中要修改的既有檔案，有疑慮時才擴大範圍；審查紀錄只列會影響實作的問題，不逐條列已通過項目。計畫修訂先依 `feedback.md` 定位需要改的段落，修改驗收條件或任務時再檢查受影響的對應關係。檔案格式、任務對驗收條件的覆蓋與任務相依仍由程式驗證；原始需求的語意覆蓋由審查者判斷，以減少反覆讀取文件的 token 用量。

**分層審查。** 任務多時，計畫審查改成每輪一次索引審查加上只審有變動的任務群。依序檢查下列條件，全部成立才分層：

1. `planReviewLayers.enabled` 為 `true`，且 `tasks.json` 與 `acceptance.json` 格式正確。
2. 任務數達到 `minTasks`。
3. 依 description 裡含目錄的檔案路徑（例如 `src/a.ts`）分群，至少分成兩群。共用檔案的任務同一群；沒寫路徑的任務併入它第一個有路徑的直接相依任務，其餘沒寫路徑的任務併成一群。
4. 最大的一群不超過任務總數的三分之二。
5. 依 `maxGroups` 與「任務數 ÷ `tasksPerGroup`」合併相鄰的群之後，仍至少兩群。
6. `plan.md` 對每個任務都有 `## T-<數字>` 這種標題（`##` 到 `######` 皆可）。

前兩項不成立時直接整份審查，不印訊息；第 3 到 6 項不成立時印出 `📋 這次計畫審查讀整份計畫：<原因>`，原因是「任務要改的檔案互相重疊，只能分成一群」、「最大的一群有 k 個任務，超過總數 n 的三分之二」、「任務數 n 不足以讓每群平均至少 m 個」或「plan.md 缺少 T-1, T-2 的「## T-<數字>」標題」。整份審查會刪掉分層審查的狀態，之後切回分層時全部重審。

索引審查者讀需求、`.flow/spec.md`、全部任務的標題與描述、驗收條文全文，以及 `plan.md` 第一個任務標題之前的整體做法；負責需求覆蓋、驗收條件、順序、技術方向與跨任務一致性（重複負責、介面假設矛盾、漏寫相依），人數是 `planReviewQuorum`，每輪都跑。群審查者讀該群任務、跨群的直接相依任務、對應的驗收條文、`plan.md` 裡該群任務標題下的難度摘錄，以及 description 點名的檔案，負責任務拆解與難度。群審查一般一位，群內有 `high` 任務時由 `planReviewQuorum` 位審查。兩者都可以讀交接事項 evidence 點名的檔案。計畫的未結交接事項由索引審查負責結案：索引核准卻仍有未結 action 算矛盾；群審查不做這項檢查，群都核准後若仍有未結事項，退回計畫修訂。

重審規則：`plan.md` 的整體做法變了，所有群都重審；任務的標題、描述、難度、驗收條文或難度證據變了，重審它所在的群；任務的驗收 id 或相依變了，連它的直接上游與下游一起重審；上次要求修改的任務一定重審。已核准又沒變動的群這輪不呼叫 agent。某一次審查呼叫失敗（agent 當掉、JSON 不合法或交接不合格）時，重跑同一輪，但這一輪已成功的呼叫直接沿用、不再呼叫 agent；計畫內容在這之間變了就整輪重來。重跑時只要有一次呼叫真的執行成功（不算沿用的），`plan-review-run` 的失敗次數就歸零，所以索引與各群輪流各失敗一次時不會累計到重試上限；同一個呼叫連續失敗仍會達到上限。整份審查每次重跑整輪，不做這項歸零。審查狀態存在 `.agentflowctl/runs/<id>/plan-review-state.json`，放在 worktree 外，agent 改不到；仲裁要求修訂時也會刪掉。

**僵持時仲裁。** 兩種情況會觸發：這輪審查意見和上一輪一樣，或已達重試上限。仲裁者只判斷一件事：照這份計畫實作，能不能滿足需求。

| 有幾家 | 誰來仲裁 | 結果 |
| --- | --- | --- |
| 三家以上 | 沒參與這次討論的那一家 | 核准就繼續，否則 run 失敗 |
| 兩家 | 兩家各自在全新 context 裡判斷 | 都核准就繼續；都不核准就依裁決意見修訂並重新審查；分歧依 `tieBreak` |
| 一家 | 同一家 | 由它自己仲裁 |

兩家時的仲裁是雙盲的。仲裁者只看計畫、`.flow/plan-replies.md`（審查意見的處理結果；沒有這份檔表示尚未回應），以及一份不含審查者名稱的爭議清單（`.flow/dispute.md`）。爭議清單用 `<issue>` 包住每則意見；給修訂者的 `.flow/feedback.md` 則用 `<opinion author="…">` 包住每位審查者的意見，避免意見內文與外層結構混淆。帶有名稱的審查紀錄移到 worktree 以外。`tieBreak` 預設 `proceed`，因為後面還有測試紅燈、綠燈、任務審查、verify 與程式碼審查；分歧時沒核准的意見會記進交接帳本，最終審查必須處理，不會只留在 `plan.md`。

計畫定案或仲裁最終停止時，裁決與每位仲裁者的理由附在 `plan.md` 最後的「仲裁紀錄」。需再修訂時，裁決理由寫進 `.flow/feedback.md`，供修訂者處理；重新審查會從第一輪計數。原始審查與每輪仲裁紀錄在 `.agentflowctl/runs/<id>/reviews/`。兩家都要求修改時不因仲裁輪數而直接失敗；整個 run 仍受 `maxAgentRuns` 限制。

仲裁 JSON 的 `verdict` 應為 `approve` 或 `changes_requested`；若模型寫成 `reject`，程式會當成 `changes_requested` 並保留理由。每筆 `status` 只能是 `met`、`not_met` 或 `partial`。缺少檔案、JSON 格式錯誤、交接無效或其他不合法輸出不算反對票，也不會暫停：程式把原因寫進 `.flow/feedback.md`、記一次 `plan-arbitration-run` 重試（分類為 `format_invalid`、`agent_error` 或 `handoff_invalid`），再重跑整組仲裁，不重跑計畫審查；無效的檔案移到 `.agentflowctl/runs/<id>/reviews/plan-arbiter-<輪次>-<仲裁者>-invalid.json`。連續達重試上限才讓 run 失敗，`resume` 會再回到仲裁。仲裁者額度用完時 run 暫停，`resume` 同樣直接回到仲裁（整份或分層都一樣），不會再花審查的費用。交付仲裁時程式在 `.agentflowctl/runs/<id>/plan-arbitration.json` 記下最後一位反對者與計畫內容雜湊，得出裁決後刪掉；resume 時計畫檔已被改過、`.flow/dispute.md` 不見了，或 `planArbiter` 已經關掉，就刪掉這份紀錄（關掉仲裁時連同爭議清單）並重新審查。

## 階段與通過條件

| 階段 | 負責的 agent | 程式認定通過的條件 | 失敗時 |
|---|---|---|---|
| spec | 隨機一位 | 檔案存在、zod 驗證、id 不重複 | 重試 |
| plan | 與 spec 同一位 | zod、相依存在、無循環、每條驗收條件都有任務、每個任務最多四條驗收條件、同一條驗收條件只有一個實作任務負責 | 重試 |
| plan_review | 計畫作者以外隨機挑（可多位，不重複） | 整份審查時所有審查者都 `approve`；分層時索引與每個有跑到的群的每位審查者都 `approve`，且沒有未結的計畫交接事項 | 進入 plan_fix |
| plan_fix | 依 `fixStrategy` | 修改後仍通過 plan 的格式與 DAG 檢查 | 還原並重試 |
| 仲裁 | 見上一節 | 一致核准；分歧依 `tieBreak` | 兩家都不核准時進入 plan_fix 再審查；第三方不核准或 `tieBreak: stop` 時失敗 |
| 人工確認 | 你（只有 `--manual-plan`） | `agentflowctl approve` | — |
| implement 紅燈 | 輪替順序中的第 i 家 | 有測試變更，而且測試執行後失敗；規格與計畫檔沒有被修改 | 還原並重試 |
| implement 綠燈 | 輪替順序中測試作者的下一家 | 測試檔與規格、計畫檔都沒有被修改，而且測試通過 | 還原，或帶著輸出重試 |
| implement 任務審查 | 輪替順序中實作者的下一家；多位時其餘從作者以外挑，不重複 | 所有審查者都 `approve` 這個任務的變更 | 進入任務修正 |
| implement 任務驗證 | — | `install` 與所有 `checks` 通過，才換下一個任務 | 進入任務修正 |
| implement 任務修正 | 與 fix 相同 | 與 fix 相同；修完重新任務審查、任務驗證 | 還原並重試 |
| verify | — | `install` 與所有 `checks` 通過；失敗的檢查先原樣重跑一次（`rerunFailedChecks`），第二次通過視為 flaky、放行並記進 `flaky.jsonl` | 兩次都失敗才交回作者修正 |
| fix | verify 失敗交回作者；審查意見依 `fixStrategy` | 沒有刪除測試檔，也沒有修改規格與計畫檔 | 還原並重試 |
| review | 作者以外隨機挑（可多位，不重複） | 所有審查者都 `approve`（審查者對程式碼與規格、計畫檔的修改一律還原） | 依 `fixStrategy` 交給他人修正 |
| pr | — | push 成功；有 `gh` 就開 PR | — |

驗收條件寫在 `.flow/acceptance.json`（`AC-1`…），任務寫在 `.flow/tasks.json`（`T-1`…）。
每個任務的寫測試與寫實作 prompt 只帶入該任務對應的驗收條件；agent 優先讀任務與相關程式碼，遇到資訊不足或矛盾才查規格、計畫的相關段落。agent 可先跑相關測試，紅燈與完整測試仍由外部流程執行與判定，減少重複讀取文件和全套測試輸出所用的 token。
計畫定案後（實作、修正、程式碼審查）不可修改 `.flow/` 裡的規格與計畫檔（`spec.md`、`acceptance.json`、`plan.md`、`tasks.json`、`tasks.ordered.json`）；實作與修正時被改就還原並重試，因為寫出的程式碼可能依賴被改過的規格，必須重寫；審查者只交出審查結果，修改直接還原即可，不必重跑審查。對規格有疑慮要寫進交接事項。
每個任務綠燈後先做任務審查：審查者只看這個任務寫測試前到目前的 diff（`.flow/diff.patch`）與這個任務的驗收條件，審查紀錄存成 `.flow/review-<任務>-<審查者>.json`。審查者依輪替排定，而且一定避開最後實作者；有第三家可選時也避開測試作者，只有兩家或審查人數不足時才由測試作者審查。任務審查不要求結清所有交接事項（可能屬於後面的任務），最後的程式碼審查才會擋。審查通過後執行任務驗證（與 verify 相同的 `install` 與 `checks`）。審查要求修改或驗證失敗都進入任務修正，修正者的挑法與 fix 相同，修完回到任務審查再驗證。審查執行或任務修正若先失敗、後成功，會清除各自的連續失敗次數。所有任務完成後，仍照原本流程對整份變更跑一次 verify 與程式碼審查。
程式碼審查（任務審查與最後的整體審查）逐條核對驗收條件，`review.json` 的 `items` 必須**每條驗收條件各一筆**（`criterion` 填 `AC-n`，通過寫 `met`，未通過寫 `not_met` 或 `partial`）：任務審查只需涵蓋該任務對應的條件，整體審查涵蓋 `acceptance.json` 全部。程式比對編號，漏掉任何一條、或寫出不存在的編號，視為 `format_invalid`，整輪審查重跑。審查者另外發現、不屬於任何驗收條件的問題是「額外發現」：`criterion` 寫簡短描述（不可用 `AC-n`），必須在 `evidence` 寫出檔案位置或檢查證據（沒寫同樣是 `format_invalid`），且只限這次變更的缺陷，不可是新需求或風格偏好。額外發現在 `feedback.md` 以 `<extra_finding>` 與驗收條件的 `<issue>` 分開標示，修正者先依 evidence 確認屬實才改，認為是新需求就不實作並以 `info` 寫進 `newIssues`。為避免審查者靠不斷提新發現讓範圍膨脹，額外發現只在該關第一次審查時能擋關（重試計數為 0）；修過一輪後若只剩額外發現，審查視同核准，這些發現改記成交接帳本裡的 `info`。審查時先看 diff 與相關檔案，驗收條件不清楚才查規格。
審查者看得到作者自己標出的風險：作者在回覆 `<result><concerns>` 寫的疑慮（「無」「沒有」這類空話不算），在關卡通過後會記成交接帳本的 `info`（「作者回報的疑慮（agent，步驟）：…」，最多 400 字），審查者讀 `handoff-context.md` 時會看到並優先查證。這只是線索，不影響任何關卡；記錄失敗也不會讓步驟失敗。
審查 prompt 新增「最小化」一項：逐一嘗試刪掉、合併或改用既有行為，能刪掉或重用而所有驗收條件仍成立的過度實作，可以列為額外發現，`evidence` 要同時寫出多餘程式碼與可重用的既有位置；單純「換一種寫法」不算。
不走 TDD 的任務沒有任何檔案變更而被略過時，程式在交接帳本留一筆 `info`，最後的整體審查要核對該任務的驗收條件是否本來就成立。
修正階段新增 `skip`／`only`／`todo`（測試檔）或 `@ts-ignore`／`@ts-nocheck`／`eslint-disable`（程式碼檔案）會被還原並以 `checks_weakened` 重試；測試檔的斷言變少在前兩次嘗試也會擋下，之後放行並印出警告（可能是合理地刪掉重複的斷言）。綠燈階段的實作同樣不可新增型別或 lint 抑制註解。範圍守衛（動到後面任務負責的檔案）除了明寫的檔案路徑，也認得描述裡的目錄（至少兩層，結尾有斜線，例如 `src/auth/`）與根目錄檔案（`package.json` 等）；沒有任何任務提到的檔案不受限，守衛達次數上限放行時會印出警告。
修正階段先依 `feedback.md` 定位問題並執行相關檢查，完整檢查仍由後續 verify 執行，以減少反覆讀取完整文件與測試輸出。

## Prompt 結構

每個階段的 prompt 都有專屬角色：需求分析師、軟體架構師、計畫審查者、計畫索引審查者、計畫群審查者、計畫修訂者、中立仲裁者、測試工程師、實作工程師、任務審查者、除錯工程師、程式碼審查者。內容用 XML 標籤分段：`<role>`、`<context>`、`<inputs>`、`<steps>`、`<constraints>`、`<output_format>`、`<reply_format>`。

Agent 的最後回覆要附上 XML 中繼資料：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>做了什麼</summary>
  <files_changed><file>src/form.ts</file></files_changed>
  <concerns>對規格或測試的疑慮</concerns>
</result>
```

`blocked` 與 `concerns` 會印在終端機上，完整回覆留在 log，可用 `agentflowctl logs` 查看。這份中繼資料只給人看；缺少或格式錯誤都不影響流程，是否通過仍由上表的程式檢查決定。

### Agent 交接紀錄

每次 agent 執行前，程式會把與當前階段有關的未結事項寫入 `.flow/handoff-context.md`。agent 完成時必須寫 `.flow/handoff-response.json`，包含 `newIssues` 和 `dispositions` 兩個陣列；沒有事項也要明確寫成 `{ "newIssues": [], "dispositions": [] }`。缺少檔案或 JSON 格式不合法，會依該步驟的重試規則處理。

程式只在原有關卡通過後接收交接回覆，並將正式紀錄原子儲存於 `.agentflowctl/runs/<id>/handoff.json`。`action` 是需要後續處理的事項；`info` 只供參考。`.flow/handoff-context.md` 把兩者分成「待處理事項」與「參考資訊」並標出類型；只有 `action` 能處置，agent 若把 `info` 或已結案的事項寫進 `dispositions`，程式會略過，不會讓整個步驟重試。寫作類步驟（規格、計畫、計畫修正、紅燈測試、綠燈實作、fix）完成且通過關卡後，若 `.flow/handoff-response.json` 不合格，會請同一家 agent 再呼叫一次，只補寫交接（不重做工作，也不換人代打）；補寫期間對其他檔案的變更與 commit 一律丟棄（規格與計畫類步驟沒有 commit，補寫者會被告知範圍為空，不會把事項標成已處理，補寫期間對規格與計畫檔的修改同樣丟棄）。補寫仍不合格或額度用完，才照舊還原這一步並重試。補寫呼叫記在原步驟名稱底下，`stats` 與 `logs` 會多一筆，也會計入 `--max-agent-runs` 的次數。計畫修正補寫後仍不合格時，修改會還原，但原本的審查意見會保留在 `feedback.md`，下一次修正仍知道要改什麼。作者只能提出已修正並附證據，審查者才能確認結案或附理由接受。XML `<concerns>` 可以供人閱讀，但重要疑慮必須寫進交接 JSON，才能交給下一位 agent。額度代打與重試不會接收失敗呼叫的交接內容；中斷後可用 `resume` 接續。

計畫審查或程式碼審查若核准，但該階段仍有未結的 `action`，程式會視為互相矛盾的審查結果並重試。計畫定案和開 PR 前也會再檢查一次。計畫定案後，實作階段的 agent 仍可能留下目標為計畫的 `action`（例如計畫與實際情況矛盾），計畫階段不會再回來處理，卻會擋下開 PR，所以程式碼階段（實作、任務審查、驗證、修正、程式碼審查）的交接清單也會列出這些 `action`，程式碼審查核准前同樣必須結清；目標為計畫的 `info` 不會帶到程式碼階段。`info` 會提供給目標階段閱讀，但不阻擋通關。審查結果本身也要一致：核准時 `items` 不可有未通過的項目，要求修改時至少要列一筆，否則視為格式錯誤並重新審查。

## Adapter

| adapter | 執行方式 | 權限 |
|---|---|---|
| `claude` | `claude -p --output-format stream-json` | acceptEdits、禁止 git 寫入、設定檔在 `.agentflowctl/runs/<id>/claude-settings.json` |
| `codex` | `codex exec --json --sandbox workspace-write`（prompt 走 stdin） | 只能改工作目錄，預設不能連網 |
| `gemini` | `gemini -p --output-format stream-json --approval-mode yolo` | 沒有細緻權限；可在 `extraArgs` 加 `--sandbox`，或放在可丟棄環境 |
| `command` | 任意指令；`{prompt}` 替換，或走 stdin | 取決於該工具 |

Codex 沙箱預設不能連網，所以建立 worktree 時會先跑 `install`。CLI 參數與事件格式更新得很快，第一次使用前先 `doctor`，再用一個小需求實測。

各家讀的專案說明檔不同：Claude Code 讀 `CLAUDE.md`，Codex 讀 `AGENTS.md`，Gemini 讀 `GEMINI.md`。把專案慣例寫在 `AGENTS.md`，另外兩個檔案各用一行引用它。agentflowctl 的 prompt 在 `prompts/`，不依賴任何一家的 skills 或 plugins。

## 額度與代打

上限是執行次數（`maxAgentRuns`，預設 60），不是金額。`status` 會列出各 agent 的執行次數與 token 數。

額度用完時：

| 步驟 | 行為 |
| --- | --- |
| 計畫審查、程式碼審查、仲裁 | 暫停。額度恢復後 `agentflowctl resume`。換人代審會變成作者審自己 |
| 規格、計畫、修改計畫、寫測試、寫實作、修正 | 隨機由另一家還有額度的 agent 代打 |
| 每家都用完 | 暫停 |

換人或暫停前，額度用完的 agent 留下的半成品會先清掉。代打寫在 `.agentflowctl/runs/<id>/substitutions.jsonl`，`status` 會列出。commit 結尾標的是實際執行的模型。

若寫實作的那家額度用完、改由寫測試的那家代打，這個任務的測試與實作就會出自同一家，`status` 會標註。審查步驟仍然暫停，等原本的另一家，因為那是此時剩下的交叉檢查。

額度錯誤靠錯誤訊息辨識（usage limit、rate limit、quota、429 等），只在 agent 執行失敗時判斷。辨識不到時，會當成一般失敗重試。

## 在哪裡跑

agentflowctl 本身只依賴 Node.js 與 git。專案指令透過系統 shell 執行。

| 環境 | 適合的用法 |
|---|---|
| 自己的電腦 | 自己的專案、自己寫的需求。剛開始可以加 `--manual-plan`，確認審查品質後再拿掉 |
| 容器、遠端開發機 | 無人值守。先在該環境內完成各家 CLI 的登入 |
| Claude Code、Codex 裡面 | 讓它們用 shell 執行 `npx agentflowctl` |

沒有容器隔離時，verify 會在你的電腦上執行 agent 寫出來的程式碼。Gemini 在無人值守時是 yolo 模式。處理外部 issue，或需求文字不是你自己寫的，放到可丟棄的環境。AI 審查計畫擋不住夾在需求裡的指示。

## 專案結構

```
src/
  cli.ts            指令列（run、doctor、status……）
  engine.ts         狀態機與各階段
  roles.ts          角色分配規則（含計畫修正者與仲裁者）
  runner.ts         執行 agent、正規化結果、執行專案指令
  logs.ts           log 檔名、檔頭檔尾、列表與解析
  stats.ts          步驟耗時與失敗（含跨 run 合併）
  insights.ts       結果、失敗原因與重試
  usageInsights.ts  用量與規則式建議
  stopReport.ts     run 停下時的結果、未結交接事項與下一步指令
  agents/           claude、codex、gemini、command
  setup.ts          agent setup 互動精靈
  git.ts            worktree 與 git 操作
  cleanup.ts        clean：移除 worktree 與 run 紀錄
  store.ts          狀態、用量、重試、代打紀錄
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

MIT，詳見 [LICENSE](../LICENSE)。
