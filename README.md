# agentflowctl

讓 Claude Code、Codex、Gemini CLI 等 agent 在同一個專案裡分工：整理需求、規劃、寫測試與程式、交叉審查，最後建立 PR。agentflowctl 負責推進流程，並用檔案、測試和檢查結果決定能否進到下一步。

目前內建支援三種 LLM CLI：**Claude Code、Codex、Gemini CLI**。未來可擴充自定義 LLM adapter，讓其他模型供應商加入流程。目前若要串接其他 CLI，可使用 `command` adapter，自行提供執行命令；需要模型驗證時，也須提供探測命令。

每次執行都會建立獨立的 git worktree 與 `flow/<id>` 分支，不會直接修改你目前的工作目錄。兩個 agent 就能運作；若只有一個，也能執行，但無法做到跨 agent 審查。

## 開始使用

需要 **Node.js 22 以上**、git，以及至少一個已安裝且完成登入的 agent CLI。建議先準備兩個，例如 Claude Code 與 Codex。

在要開發的專案根目錄執行：

```bash
npx agentflowctl agent setup
npx agentflowctl doctor
npx agentflowctl run --req "登入表單加入驗證與錯誤訊息"
```

`agent setup` 會找出本機可用的 Claude Code、Codex、Gemini CLI，讓你選擇要加入哪些 agent，並寫入專案根目錄的 `flow.config.json`。`doctor` 會檢查設定與 CLI 是否可執行。agentflowctl 沒有預設 agent，因此第一次使用要先完成設定。

若要使用現成的需求文件，改用：

```bash
npx agentflowctl run --req-file ./requirement.md
```

下文以 `agentflowctl` 為例；未全域安裝時，在指令前加 `npx`。想全域安裝可執行 `npm install -g agentflowctl`。

## 執行時會發生什麼

1. agent 整理需求與驗收條件，接著寫計畫，交給其他 agent 審查。
2. 依計畫逐個任務寫出會失敗的測試，再由另一位 agent 實作到測試通過；每個任務都會經過審查與驗證。
3. 全部任務完成後，再執行專案檢查與整體程式碼審查。未通過的項目會交回修正。
4. 有 `origin` 時會推送分支；若 `gh` 可用，會嘗試建立 PR。沒有 `origin` 時，完成的分支留在本機。

流程預設會自動往下走。想在計畫通過審查後親自確認，可加 `--manual-plan`；確認後執行 `agentflowctl approve <id>`。

agentflowctl 會依專案的 `packageManager`、lockfile 與 `package.json` scripts 選擇安裝、測試及檢查指令。第一次執行時，請留意終端機印出的偵測結果；需要調整可在 `flow.config.json` 指定 `install`、`test` 或 `checks`。

## 查看進度

`run` 開始時會印出 run id，例如 `f-xxxx`。執行中預設只顯示階段進度；加 `-v` 可看到 agent 文字、工具呼叫與專案指令。

```bash
agentflowctl list                  # 列出 run
agentflowctl status f-xxxx         # 看進度、結果與下一步
agentflowctl logs f-xxxx           # 列出各步驟的 log
agentflowctl logs f-xxxx --latest  # 看最新一份 log
agentflowctl stats f-xxxx          # 各步驟耗時、執行與失敗次數
agentflowctl resume f-xxxx         # 從暫停、中斷或失敗處接續
```

`status` 會列出目前階段、未結的交接事項與下一步指令；失敗或暫停時也會顯示原因。要看某一步的詳細輸出，可用 `logs <id> <編號>`；加 `--full` 看完整工具內容，或加 `--raw` 看原始輸出。

`stats` 依 log 的開始與結束時間統計每個步驟的執行次數、失敗次數、總耗時與最長一次，並分開列出 agent 與專案指令（install、測試、checks）各占多少時間，最耗時的步驟排在最前面。沒有結束紀錄的 log 列為未完成，不計入耗時；總經過時間包含暫停與等待核准。

執行紀錄在 `.agentflowctl/runs/<id>/`，工作分支在 `.agentflowctl/worktrees/<id>/`。不再需要某次 run 時，可用 `agentflowctl clean <id>` 清除 worktree 與紀錄；`flow/<id>` 分支會保留。

## 執行停下來時怎麼做

先執行 `agentflowctl status <id>`，看「階段」與「原因」，再依情況處理：

| 狀況 | 下一步 |
| --- | --- |
| 按 Ctrl-C，或終端機意外關閉 | 執行 `agentflowctl resume <id>`；沒有結束紀錄的步驟會重跑 |
| `awaiting_approval`：計畫等你確認 | 閱讀 `.agentflowctl/worktrees/<id>/.flow/plan.md`，確認後執行 `agentflowctl approve <id>` |
| `paused`：agent 額度用完 | 等額度恢復後執行 `agentflowctl resume <id>`；審查步驟不會換 agent 代審 |
| `paused`：仲裁沒有產生有效裁決 | 依 `status` 的原因查看 log；若有 `.flow/plan-arbiter.json`，也檢查其內容，處理後執行 `agentflowctl resume <id>` |
| `failed`：測試、檢查、審查或 agent 執行失敗 | 依 `status` 提示查看失敗的 log，處理原因後執行 `agentflowctl resume <id>`；失敗階段會重試 |
| `failed`：已達 agent 執行次數上限 | 用 `agentflowctl resume <id> --max-agent-runs 100` 調高上限後接續，數字須大於已執行次數 |

例如失敗時，可照終端機列出的 log 編號查看原因：

```bash
agentflowctl status f-xxxx
agentflowctl logs f-xxxx 7
agentflowctl resume f-xxxx
```

若不打算接續，先用 `agentflowctl cancel <id>` 標記放棄，再用 `agentflowctl clean <id>` 清除 worktree 與執行紀錄。仍在執行中的 run，先在原終端機按 Ctrl-C。`clean` 會保留 `flow/<id>` 分支。

## 參數怎麼設定

設定分成三處：**這次執行的選項**寫在 `run` 或 `resume` 後面；**專案設定**寫在專案根目錄的 `flow.config.json`；**執行環境設定**用環境變數。先用 `agent setup` 建立 agent 設定，再視需要調整其他欄位。

### 指令選項

| 指令或選項 | 怎麼設定 |
| --- | --- |
| `run --req "..."` / `--req-file <檔案>` | 二選一，直接輸入需求或讀取檔案 |
| `run --manual-plan` | 計畫通過審查後等待你確認，再用 `approve <id>` 繼續 |
| `run --cycle <名單>` | 指定這次參與的 agent，例如 `--cycle claude,codex`；優先於設定檔的 `cycle` |
| `run --model-mode balanced\|adaptive` | 只覆蓋這次 run 的模型模式；`resume` 沿用建立時的模式 |
| `run --base <分支>` | 指定起始分支；未設定時使用目前分支 |
| `run --max-agent-runs <次數>` | 覆蓋這次的 `maxAgentRuns`；上限不夠時可用 `resume <id> --max-agent-runs <次數>` 調高 |
| `-v` / `--verbose` | 執行時顯示 agent 文字、工具呼叫與專案指令，適用於 `run`、`resume`、`approve` |

例如：

```bash
agentflowctl run --req-file ./requirement.md --cycle claude,codex --max-agent-runs 80 --manual-plan
agentflowctl resume f-xxxx --max-agent-runs 100
```

### Agent 設定

`agent setup` 可互動選擇已安裝的 CLI。也可以用指令新增或修改；這些指令會寫入 `flow.config.json`：

```bash
agentflowctl agent add claude --adapter claude
agentflowctl agent add codex --adapter codex --model 你要用的模型
agentflowctl agent set codex --model 另一個模型
agentflowctl agent list
agentflowctl agent cycle claude,codex
```

`agent add` 的 `--adapter` 可填 `claude`、`codex`、`gemini` 或 `command`。`--model` 指定個別 agent 的模型；`--extra-arg=--參數` 可重複使用，傳給該 CLI。使用 `command` adapter 時，把指令寫在 `--` 後，例如 `agentflowctl agent add aider --adapter command -- aider --message {prompt}`。`agent remove <名稱>` 會移除設定與參與名單；`agent cycle` 不帶名單則顯示目前參與者。

`model add/set/remove` 只修改指定 agent 的模型清單；`model remove` 移除最後一個模型時，會檢查參與的 agent 是否仍有模型，不論目前使用哪種模型模式。同一 adapter 的 `agent set` 會保留清單；換 adapter 時會清掉舊 adapter 的模型設定。`agent setup` 遇到同名 agent 會先詢問是否覆寫。

### 依階段與任務難度選模型

預設是 `balanced`：沿用每個 agent 的 `model`、`defaultModels` 或 CLI 預設。想啟用自動選模，先為**每個參與的 agent** 登記可用模型與強度，再切換模式：

```bash
agentflowctl model add claude MODEL_NAME --strength low
agentflowctl model add claude ANOTHER_MODEL --strength high
agentflowctl model list
agentflowctl model mode adaptive
agentflowctl run --req-file ./requirement.md
```

把 `MODEL_NAME` 換成該 CLI 目前可呼叫的別名或完整 ID。`model add` 會用目前登入的帳號送出短請求，可能耗用少量 token；成功才寫入設定。需要重驗時執行 `model check`。用 `model set claude MODEL_NAME --strength medium` 改強度、`model remove claude MODEL_NAME` 移除模型，或用 `model stage taskReview high` 調整階段最低強度；`model stage` 不帶強度時列出各階段實際生效的強度。終端機每次呼叫會顯示送給 CLI 的模型名稱，Claude Code 與 Gemini CLI 回報的實際模型不同時也會顯示；`status <id>` 會按階段、任務、模型與步驟顯示用量。`run --model-mode balanced` 可暫時回到原設定。

`status <id>` 的用量以每次 LLM 呼叫為一筆，失敗、額度用完及代打也會計入呼叫次數。只有 CLI 同時回報輸入與輸出 token，才把兩者納入合計與模型強度占比；明確回報的 0 仍算已回報。缺少任一數字列為「未回報」；舊紀錄無法分辨真實 0 與預設補值，列為「舊紀錄不明」，原始數字只供查閱。各 agent、階段、任務、模型與步驟、模型強度是同一批呼叫的不同分組，不應跨組相加。輸入 token 一律包含 cache 讀取與寫入：Claude Code 回報的 `input_tokens` 不含 cache，agentflowctl 會把 cache 讀寫加回去；Codex 的 `input_tokens` 本來就包含 cache。有回報 cache 時，`status` 與 `logs` 會另外標出其中讀取與寫入 cache 各多少。`model add/check` 的探測請求可能耗用 token，但不屬於 run，因此不在 `status` 內。

計畫 agent 會查閱相關程式碼，依影響範圍、技術不確定性與失敗後果為每個任務標註 `low`／`medium`／`high` 難度，取三者中最高等級，並在計畫中寫出依據；計畫審查會逐項核對。自動選模先遵守角色分配，再取階段強度與任務難度中較高者；失敗重試會提高強度。若分配到的 agent 沒有足夠強度的模型，會選它最強的模型並提示。這些強度是你對模型能力的設定，不由 CLI 自動評分。

#### 模型驗證

Claude Code、Codex 與 Gemini CLI 都使用專用探測流程：以 `--model` 指定模型，在獨立暫存目錄要求「只回答 OK」，不沿用正常工作時的 `extraArgs`。

| CLI | 探測時的工具限制 |
|---|---|
| Claude Code | `--tools ""` 停用內建工具，`--strict-mcp-config` 不載入外部 MCP，`--disable-slash-commands` 停用 slash commands |
| Codex | 唯讀沙箱與 `approval_policy="never"` 禁止寫入及權限升級；停用 shell、外部工具與 hooks，忽略使用者設定及 rules。仍可能有模型內建檔案工具，由唯讀沙箱限制 |
| Gemini CLI | admin/user policy 禁止所有工具（合法優先級 `999`），停用 extensions、MCP 與 hooks；政策載入問題使驗證失敗 |

三家共用相同的通過條件：CLI 結束碼為 0、有非空文字與成功完成事件，且沒有工具嘗試或失敗事件。即使後來回覆成功，先前的失敗也不會被忽略；Codex 只在 stderr 回報的工具拒絕同樣算失敗。Codex 的非致命錯誤通知（例如找不到模型 metadata 改用預設值）不影響結果，`logs` 以 ⚠️ 顯示，不列入錯誤段落；模型被改派時顯示為 CLI 回報的實際模型。

探測上限為 30 秒，結束後清除暫存目錄；macOS／Linux 逾時或按 Ctrl-C 中斷時會停止整個程序群組，包含 CLI 啟動的子程序。`model add` 成功才新增模型，失敗保持設定原狀；`model check` 只重驗、不修改設定。CLI 不支援探測參數時會提示更新，不會改用更寬鬆的權限重試。

Codex 未回報實際模型 ID 時，只確認指定名稱可呼叫，不推測別名對應；`logs` 會顯示 Codex 的完成事件，跨回合的 shell 指令分開整理。自訂 `command` adapter 另需提供會實際呼叫模型的探測命令；設定方式與各 CLI 已查核版本見[詳細參考](docs/reference.md#模型設定與自動選模)。

### 專案設定

你也可以直接編輯 `flow.config.json`。這是可用的最小範例；沒有寫的欄位會使用預設值：

```json
{
  "agents": {
    "claude": { "adapter": "claude" },
    "codex": { "adapter": "codex", "model": "你要用的模型" }
  },
  "cycle": ["claude", "codex"],
  "maxAgentRuns": 80
}
```

| 欄位 | 預設 | 設定方式與用途 |
| --- | --- | --- |
| `agents` | `{}` | 以名稱為 key 定義 agent；每個都要有 `adapter`，可加 `model`、`extraArgs`；`command` adapter 另需 `command` 指令陣列 |
| `cycle` | 自動偵測 | 填 agent 名稱陣列，例如 `["claude", "codex"]`；未填時使用已設定且可執行的 agent；順序不決定角色 |
| `defaultModels` | `{}` | 依 adapter 設預設模型，例如 `{ "claude": "模型名稱" }`；個別 agent 的 `model` 優先 |
| `modelSelection` | `balanced` | `mode` 可為 `balanced` 或 `adaptive`；`stageStrength` 可覆蓋各 LLM 階段強度 |
| `agents.<名稱>.models` | 無 | 自動選模時使用；每筆有 `name` 與 `strength`，建議用 `model add` 設定並實際驗證 |
| `fixStrategy` | `"ring"` | `"ring"` 由審查者以外的 agent 修正；`"author"` 交回最後作者 |
| `tddSplit` | `true` | 有多位 agent 時，`true` 會把同一任務的測試與實作分給不同 agent |
| `reviewQuorum` | `1` | 任務與最終程式碼審查需要幾位不同審查者核准 |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者核准 |
| `planArbiter` | `true` | 計畫審查僵持時是否啟用仲裁 |
| `tieBreak` | `"proceed"` | 兩位仲裁者意見分歧時，`"proceed"` 繼續、`"stop"` 停止 |
| `maxAgentRuns` | `60` | 一次 run 最多執行幾次 agent；可用指令選項覆蓋 |
| `install`、`test` | 依專案偵測 | 寫成指令字串，例如 `"install": "pnpm install"` |
| `checks` | 依專案偵測 | 檢查清單，例如 `[{ "name": "test", "cmd": "pnpm test" }]`；提供時會取代整份預設清單 |
| `testPattern` | 常見的 `.test.`、`.spec.` 檔名 | 辨識測試檔的正規表示式字串；非標準檔名時調整 |

`install`、`test`、`checks` 未設定時，會依 `packageManager`、lockfile 和 `package.json` scripts 偵測。完整範例見 [examples/flow.config.json](examples/flow.config.json)。專案設定每一步都會重新讀取，但已建立 run 的參與 agent 與執行次數上限會沿用建立時的值；要調高後者請用 `resume --max-agent-runs`。

### 環境變數

| 變數 | 預設 | 設定方式與用途 |
| --- | --- | --- |
| `AGENTFLOWCTL_MAX_ATTEMPTS` | `3` | 同一關連續失敗幾次後停止；例如 `AGENTFLOWCTL_MAX_ATTEMPTS=10 agentflowctl run --req "..."` |
| `AGENTFLOWCTL_VERBOSE` | 未開啟 | 設為 `1` 顯示詳細輸出，效果同 `-v` |
| `AGENTFLOWCTL_MAX_TURNS` | `80` | 目前程式會讀取此值，但尚未用它限制 agent 執行 |

環境變數對新啟動的 agentflowctl 程序生效。`AGENTFLOWCTL_MAX_ATTEMPTS` 是單一關卡的重試上限；`maxAgentRuns` 則是整次 run 的 agent 執行次數上限。修正成功、或計畫審查與程式碼審查整組完成一輪有效審查後，該關的失敗次數會歸零，所以上限只計算連續失敗。

## 更多文件

- [完整指令、設定與流程說明](docs/reference.md)：選項、角色分配、審查規則、log、額度處理與技術細節。
- [各階段讀寫的檔案](docs/engine-stage-files.md)：`.flow/`、回饋與審查檔案如何交接。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
