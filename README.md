# agentflowctl

讓 Claude Code、Codex、Gemini CLI（或任何 agent CLI）在同一條流程裡輪流寫規格、寫計畫、寫測試、寫實作、互相審查、互相修正，一路做到開 PR。

```
需求 → spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（測試 A → 實作 B）→ verify ⇄ fix → review ⇄ fix → pr
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

同一個模型審查自己的程式碼，容易放過自己的寫法；測試和實作出自同一個模型，也容易寫出剛好會過的測試。角色分配只有三條規則，定義在 `src/roles.ts`：

| 規則 | 效果 |
|---|---|
| 審查者永遠不是最後寫程式的 agent，多位審查者彼此不重複 | 每一輪審查都由另一家看 |
| 同一個任務的測試與實作由不同 agent 負責（`tddSplit`） | A 寫的測試，B 實作到通過，而且不能改測試 |
| 人選隨機決定，不依 `cycle` 的順序 | 各家輪流當作者、審查者、修正者，不會固定由同一家起頭 |

`cycle` 只決定哪些 agent 參與。隨機以 run id 為種子，同一個 run 的同一步驟 `resume` 後仍是同一家。寫測試的人每 N 個任務（N 為參與的家數）洗一次牌，每家各輪一次，換輪時也不會連續兩個任務由同一家寫測試。

兩家時是乒乓，例如：

```
計畫：codex 撰寫 → claude 審查（要求修改）→ codex 修改 → claude 審查（核准）
T-1  測試：claude   實作：codex
T-2  測試：codex    實作：claude
審查：codex（最後作者是 claude）→ 要求修改 → claude 修正 → codex 審查（核准）
```

三家時，每一輪的審查者從作者以外隨機挑，修正者從審查者以外隨機挑；仲裁交給沒寫過這份計畫、也沒審過它的那一家（有多家時隨機挑一家）。

每個 commit 訊息結尾會標上實際作者，例如 `feat(T-2): 匯出 [gemini]`。

只裝一家也能跑完，只是審查、測試、實作都會落在同一家。

## 指令

```bash
agentflowctl run --req "..."
agentflowctl run --req-file ./req.md --cycle codex,claude --max-agent-runs 40
agentflowctl run --req "..." --manual-plan   # 計畫通過 AI 審查後，仍停下來等你確認

agentflowctl approve f-xxxx        # 搭配 --manual-plan
agentflowctl status f-xxxx         # 階段、上一步結果、未結交接事項、下一步指令、任務進度、各 agent 用量、代打紀錄
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
| `--manual-plan` | 計畫通過審查後進入 `awaiting_approval`，等 `approve` 才開始實作 |
| `-v` / `--verbose` | 執行時印出 agent 的文字、工具呼叫與專案指令；`run`、`resume`、`approve` 都適用，也可設 `AGENTFLOWCTL_VERBOSE=1` |

`status` 會列出任務。進行中的任務會標出正在寫測試還是正在寫實作。

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
| `reviewQuorum` | `1` | 程式碼需要幾位不同審查者都 `approve` |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者都 `approve` |
| `planArbiter` | `true` | 計畫審查僵持時交付仲裁。關掉之後，僵持會直接讓 run 失敗 |
| `tieBreak` | `proceed` | 兩家仲裁意見分歧時：`proceed` 繼續並記錄爭議；`stop` 停下 |
| `maxAgentRuns` | `60` | 單一 run 最多執行幾次 agent |
| `install` / `test` / `checks` | 依專案偵測 | 安裝、測試與 verify 階段實際執行的指令 |
| `agents` | `{}` | 可用的 agent，沒有內建的。每個都要指定 adapter（`claude`、`codex`、`gemini`，或用 `command` 接上其他 CLI） |

verify 失敗（型別、lint、建置）一律交回最後作者。審查意見才依 `fixStrategy` 決定修正者。

### 專案指令的偵測

`install`、`test`、`checks` 沒寫在 `flow.config.json` 時，每次讀設定都會依專案現況推出指令，不寫檔。有寫的欄位一律照你的設定。

- 套件管理器：先看 `package.json` 的 `packageManager`，再看 lockfile（`pnpm-lock.yaml`、`yarn.lock`、`bun.lock`／`bun.lockb`、`package-lock.json`），都沒有就用 npm。
- `install`：`pnpm install`、`yarn install`、`bun install` 或 `npm install --no-audit --no-fund`。不鎖 lockfile，因為實作時 agent 可能新增依賴。
- `checks`：typecheck、lint、test、build 四項。`package.json` 有對應的 script（`typecheck`／`type-check`、`lint`、`test`、`build`）就用 `<pm> run <script>`，否則用 `tsc --noEmit`、`eslint .`、`vitest run`、`vite build`，前面加上 `npx`、`pnpm exec`、`yarn` 或 `bunx`。
- `test`：`vitest run`，前綴同上。

`run` 建立 worktree 後會印出這次偵測到的指令：

```
[f-xxxx] 🔧 依專案偵測指令：pnpm（依 package.json 的 packageManager）
[f-xxxx]    install：pnpm install
[f-xxxx]    checks.typecheck：pnpm run type-check
```

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

- `set --adapter` 換 adapter 時，會清掉舊 adapter 的 `model`、`extraArgs`、`command`，這次有重新指定的除外。
- `remove` 會一併從 `cycle` 移除。`cycle` 變空就刪除這個欄位，改回從 `agents` 自動偵測。
- `--extra-arg` 可以重複指定，會整個取代原本的 `extraArgs`。參數以 `-` 開頭時，寫成 `--extra-arg=--sandbox`。
- `setup` 只詢問偵測到已安裝的 CLI，一個都沒有就不變更設定。遇到已存在的名稱會先問要不要覆寫；不覆寫時保留原設定，但仍會參與。在非互動式環境（CI、管線）裡請改用 `agent add`。`command` adapter 要自己寫指令，不在 `setup` 裡。

已建立的 run 會沿用建立時參與的 agent，不受這些修改影響。

## 計畫怎麼在沒有人的情況下通過

人工確認計畫是為了擋住方向錯了還一路做下去。預設用三層機制取代它；加上 `--manual-plan` 時，三層都過了仍會停下來等你。

**格式與覆蓋率。** 每次撰寫或修改計畫之後，都要重新通過 zod、任務相依、無循環、每條驗收條件都有任務負責，而且每個任務最多對應兩條驗收條件（一次只做一件事，最多兩件）。沒過就還原。

**跨模型審查。** 審查看需求覆蓋、驗收條件能不能測且一條只寫一個行為、任務是否只做一件事（最多兩件）與技術方向。審查者只能寫意見。若改了規格或計畫，檔案會被還原。修改者要在 `plan.md` 的「審查回應」逐條回覆；不同意要寫理由。

**僵持時仲裁。** 兩種情況會觸發：這輪審查意見和上一輪一樣，或已達重試上限。仲裁者只判斷一件事：照這份計畫實作，能不能滿足需求。

| 有幾家 | 誰來仲裁 | 結果 |
| --- | --- | --- |
| 三家以上 | 沒參與這次討論的那一家 | 核准就繼續，否則 run 失敗 |
| 兩家 | 兩家各自在全新 context 裡判斷 | 都核准就繼續；都不核准就依裁決意見修訂並重新審查；分歧依 `tieBreak` |
| 一家 | 同一家 | 由它自己仲裁 |

兩家時的仲裁是雙盲的。仲裁者只看計畫，以及一份不含審查者名稱的爭議清單（`.flow/dispute.md`）。爭議清單用 `<issue>` 包住每則意見；給修訂者的 `.flow/feedback.md` 則用 `<opinion author="…">` 包住每位審查者的意見，避免意見內文與外層結構混淆。帶有名稱的審查紀錄移到 worktree 以外。`tieBreak` 預設 `proceed`，因為後面還有測試紅燈、綠燈、verify 與程式碼審查。

計畫定案或仲裁最終停止時，裁決與每位仲裁者的理由附在 `plan.md` 最後的「仲裁紀錄」。需再修訂時，裁決理由寫進 `.flow/feedback.md`，供修訂者處理；重新審查會從第一輪計數。原始審查與每輪仲裁紀錄在 `.agentflowctl/runs/<id>/reviews/`。兩家都要求修改時不因仲裁輪數而直接失敗；整個 run 仍受 `maxAgentRuns` 限制。

仲裁 JSON 的 `verdict` 應為 `approve` 或 `changes_requested`；若模型寫成 `reject`，程式會當成 `changes_requested` 並保留理由。缺少檔案、JSON 格式錯誤或其他不合法輸出不算反對票，run 會暫停並顯示驗證錯誤；檢查 `agentflowctl logs <id>` 與 `.flow/plan-arbiter.json` 後可用 `resume` 重新執行。

## 階段與通過條件

| 階段 | 負責的 agent | 程式認定通過的條件 | 失敗時 |
|---|---|---|---|
| spec | 隨機一位 | 檔案存在、zod 驗證、id 不重複 | 重試 |
| plan | 與 spec 同一位 | zod、相依存在、無循環、每條驗收條件都有任務、每個任務最多兩條驗收條件 | 重試 |
| plan_review | 計畫作者以外隨機挑（可多位，不重複） | 所有審查者都 `approve` | 進入 plan_fix |
| plan_fix | 依 `fixStrategy` | 修改後仍通過 plan 的格式與 DAG 檢查 | 還原並重試 |
| 仲裁 | 見上一節 | 一致核准；分歧依 `tieBreak` | 兩家都不核准時進入 plan_fix 再審查；第三方不核准或 `tieBreak: stop` 時失敗 |
| 人工確認 | 你（只有 `--manual-plan`） | `agentflowctl approve` | — |
| implement 紅燈 | 洗牌輪流，每家各一次 | 有測試變更，而且測試執行後失敗；規格與計畫檔沒有被修改 | 還原並重試 |
| implement 綠燈 | 測試作者以外隨機一位 | 測試檔與規格、計畫檔都沒有被修改，而且測試通過 | 還原，或帶著輸出重試 |
| verify | — | `install` 與所有 `checks` 通過 | 交回作者修正 |
| review | 作者以外隨機挑（可多位，不重複） | 所有審查者都 `approve` | 依 `fixStrategy` 交給他人修正 |
| pr | — | push 成功；有 `gh` 就開 PR | — |

驗收條件寫在 `.flow/acceptance.json`（`AC-1`…），任務寫在 `.flow/tasks.json`（`T-1`…）。
每個任務的寫測試與寫實作 prompt 只帶入該任務對應的驗收條件；agent 優先讀任務與相關程式碼，遇到資訊不足或矛盾才查規格、計畫的相關段落。agent 可先跑相關測試，紅燈與完整測試仍由外部流程執行與判定，減少重複讀取文件和全套測試輸出所用的 token。
實作階段不可修改 `.flow/` 裡的規格與計畫檔（`spec.md`、`acceptance.json`、`plan.md`、`tasks.json`、`tasks.ordered.json`）；被改就還原並重試，對規格有疑慮要寫進交接事項。
程式碼審查仍逐條核對所有驗收條件，但只在 `review.json` 列出未通過或其他重要問題；先看 diff 與相關檔案，驗收條件不清楚時才查規格。修正階段先依 `feedback.md` 定位問題並執行相關檢查，完整檢查仍由後續 verify 執行，以減少反覆讀取完整文件與測試輸出。

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

`blocked` 與 `concerns` 會印在終端機上，完整回覆留在 log，可用 `agentflowctl logs` 查看。這份中繼資料只給人看；缺少或格式錯誤都不影響流程，是否通過仍由上表的程式檢查決定。

### Agent 交接紀錄

每次 agent 執行前，程式會把與當前階段有關的未結事項寫入 `.flow/handoff-context.md`。agent 完成時必須寫 `.flow/handoff-response.json`，包含 `newIssues` 和 `dispositions` 兩個陣列；沒有事項也要明確寫成 `{ "newIssues": [], "dispositions": [] }`。缺少檔案或 JSON 格式不合法，會依該步驟的重試規則處理。

程式只在原有關卡通過後接收交接回覆，並將正式紀錄原子儲存於 `.agentflowctl/runs/<id>/handoff.json`。`action` 是需要後續處理的事項；`info` 只供參考。作者只能提出已修正並附證據，審查者才能確認結案或附理由接受。XML `<concerns>` 可以供人閱讀，但重要疑慮必須寫進交接 JSON，才能交給下一位 agent。額度代打與重試不會接收失敗呼叫的交接內容；中斷後可用 `resume` 接續。

計畫審查或程式碼審查若核准，但該階段仍有未結的 `action`，程式會視為互相矛盾的審查結果並重試。計畫定案和開 PR 前也會再檢查一次；`info` 會提供給目標階段閱讀，但不阻擋通關。審查結果本身也要一致：核准時 `items` 不可有未通過的項目，要求修改時至少要列一筆，否則視為格式錯誤並重新審查。

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
  stopReport.ts     run 停下時的結果、未結交接事項與下一步指令
  agents/           claude、codex、gemini、command
  setup.ts          agent setup 互動精靈
  git.ts            worktree 與 git 操作
  cleanup.ts        clean：移除 worktree 與 run 紀錄
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
