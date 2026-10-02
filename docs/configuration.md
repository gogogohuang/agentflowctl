# 設定詳解

操作說明請看 [README](../README.md)。本文件說明參數怎麼設定、agent 與模型選擇、專案設定欄位，以及平行執行。

設定分成三處：**這次執行的選項**寫在 `run` 或 `resume` 後面；**專案設定**寫在專案根目錄的 `flow.config.json`；**執行環境設定**用環境變數。先用 `config agent setup` 建立 agent 設定，再視需要調整其他欄位。

## 指令分層

指令分三層：**執行**（`run`、`approve`、`replan`、`resume`、`cancel`、`clean`）、**檢視**（`status`、`confirmations`、`list`、`logs`、`stats`、`insights`），以及全部放在 `config` 底下的**設定**：

```
config agent list | add | set | remove | cycle | setup   管理 agent 與參與名單
config agent model add | set | remove | list | check      某個 agent 的模型清單、強度與 effort
config selection mode | stage                             選模策略：模型模式、各階段最低強度
config doctor                                             檢查 CLI 是否可執行與主要設定
```

模型清單屬於個別 agent，所以放在 `config agent model`；模型模式與階段強度是整個專案共用的策略，放在 `config selection`（對應 `flow.config.json` 的 `modelSelection`）。舊的 `agent …`、`model …`、`doctor` 已移除。

## 指令選項

| 指令或選項 | 怎麼設定 |
| --- | --- |
| `run --req "..."` / `--req-file <檔案>` | 二選一，直接輸入需求或讀取檔案 |
| `replan <id> --note <文字>`／`--note-file <路徑>`／`--no-review` | 補充意見或手改計畫檔後重做計畫，見[執行流程細節](workflow.md#計畫有疑慮時不必整份重寫)；`--no-review` 改完不再送審 |
| `run --manual-plan` | 計畫通過審查後等待你確認，再用 `approve <id>` 繼續 |
| `run --stop-after <階段>` | 在 `spec`、`plan`、`implement`、`verify` 或 `review` 完成後暫停；`pr` 會完成 PR 流程並結束。與 `--manual-plan` 互斥 |
| `run --cycle <名單>` | 指定這次參與的 agent，例如 `--cycle claude,codex`；優先於設定檔的 `cycle` |
| `run --model-mode balanced\|adaptive` | 只覆蓋這次 run 的模型模式；`resume` 沿用建立時的模式 |
| `run --base <分支>` | 指定起始分支；未設定時使用目前分支 |
| `run --max-attempts <次數>` | 覆蓋這次的重試上限（至少 3；預設取 `flow.config.json` 的 `maxAttempts`，未設定為 5）；失敗後可用 `resume <id> --max-attempts <次數>` 調高 |
| `run --max-agent-runs <次數>` | 直接指定這次的上限，之後計畫定案也不再依任務數改算；上限不夠時可用 `resume <id> --max-agent-runs <次數>` 調高（同樣視為明確指定） |
| `-v` / `--verbose` | 執行時顯示 agent 文字、工具呼叫與專案指令，適用於 `run`、`resume`、`approve` |

例如：

```bash
agentflowctl run --req-file ./requirement.md --cycle claude,codex --max-agent-runs 80 --manual-plan
agentflowctl run --req-file ./requirement.md --stop-after plan
agentflowctl resume f-xxxx --max-agent-runs 100
agentflowctl resume f-xxxx --max-attempts 8
```

## Agent 設定

`config agent setup` 可互動選擇已安裝的 CLI 與模型模式。也可以用指令新增或修改；這些指令會寫入 `flow.config.json`：

```bash
agentflowctl config agent add claude --adapter claude
agentflowctl config agent add codex --adapter codex --model 你要用的模型
agentflowctl config agent set codex --model 另一個模型
agentflowctl config agent list
agentflowctl config agent cycle claude,codex
```

`config agent add` 的 `--adapter` 可填 `claude`、`codex`、`gemini` 或 `command`。`--model` 指定個別 agent 的模型；`--extra-arg=--參數` 可重複使用，傳給該 CLI。使用 `command` adapter 時，把指令寫在 `--` 後，例如 `agentflowctl config agent add aider --adapter command -- aider --message {prompt}`。`config agent remove <名稱>` 會移除設定與參與名單；`config agent cycle` 不帶名單則顯示目前參與者。

`config agent model add/set/remove` 只修改指定 agent 的模型清單；`config agent model remove` 移除最後一個模型時，會檢查參與的 agent 是否仍有模型，不論目前使用哪種模型模式。同一 adapter 的 `config agent set` 會保留清單；換 adapter 時會清掉舊 adapter 的模型設定。`config agent setup` 遇到同名 agent 會先詢問是否覆寫。Claude Code 與 Codex 在問完 `model` 後會再問 `effort`（Enter 不指定）。每個 agent 設定後，都可先逐行登記可選模型、強度與 effort（Enter 略過或結束）；即使最後選 balanced 也會保留清單，選 adaptive 時不再詢問已有模型清單的 agent。`config agent setup` 最後會問模型模式：預設 `balanced`（設定裡已是 adaptive 時預設沿用 adaptive）；選 `adaptive` 時會逐一詢問缺 `models` 的參與 agent，輸入「名稱 強度 effort」（強度省略為 medium，effort 可省略，Enter 結束），任何一個 agent 沒登記模型就回到模式選擇。精靈只寫入設定、不送請求驗證，寫入後可執行 `config agent model check`。若 adaptive 模式下參與的 agent 缺 `models`，`run` 會列出所有缺 `models` 的 agent，並附上 `config agent model add` 與 `config selection mode balanced` 兩種修法。

## 依階段與任務難度選模型

預設是 `balanced`：沿用每個 agent 的 `model`、`defaultModels` 或 CLI 預設。想啟用自動選模，先為**每個參與的 agent** 登記可用模型與強度，再切換模式：

```bash
agentflowctl config agent model add claude MODEL_NAME --strength low
agentflowctl config agent model add claude ANOTHER_MODEL --strength high
agentflowctl config agent model list
agentflowctl config selection mode adaptive
agentflowctl run --req-file ./requirement.md
```

把 `MODEL_NAME` 換成該 CLI 目前可呼叫的別名或完整 ID。`config agent model add` 會用目前登入的帳號送出短請求，可能耗用少量 token；成功才寫入設定。需要重驗時執行 `config agent model check`。用 `config agent model set claude MODEL_NAME --strength medium` 改強度、`config agent model remove claude MODEL_NAME` 移除模型，或用 `config selection stage taskReview high` 調整階段最低強度；`config selection stage` 不帶強度時列出各階段實際生效的強度。終端機每次呼叫會顯示送給 CLI 的模型名稱；CLI 回報的實際模型不同時也會顯示（Claude Code 與 Gemini CLI 每次回報，Codex 只在模型被改派時回報）；`status <id>` 會按階段、任務、模型與步驟顯示用量。`run --model-mode balanced` 可暫時回到原設定。

`status <id>` 的用量以每次 LLM 呼叫為一筆，失敗、額度用完及代打也會計入呼叫次數。只有 CLI 同時回報輸入與輸出 token，才把兩者納入合計與模型強度占比；明確回報的 0 仍算已回報。缺少任一數字列為「未回報」；舊紀錄無法分辨真實 0 與預設補值，列為「舊紀錄不明」，原始數字只供查閱。各 agent、階段、任務、模型與步驟、模型強度是同一批呼叫的不同分組，不應跨組相加。輸入 token 一律包含 cache 讀取與寫入：Claude Code 回報的 `input_tokens` 不含 cache，agentflowctl 會把 cache 讀寫加回去；Codex 的 `input_tokens` 本來就包含 cache。有回報 cache 時，`status` 與 `logs` 會另外標出其中讀取與寫入 cache 各多少。`config agent model add/check` 的探測請求可能耗用 token，但不屬於 run，因此不在 `status` 內。

計畫 agent 會查閱相關程式碼，依影響範圍、技術不確定性與失敗後果為每個任務標註 `low`／`medium`／`high` 難度，取三者中最高等級，並在計畫中寫出依據；計畫審查會逐項核對。自動選模先遵守角色分配，再取階段強度與任務難度中較高者；失敗重試會提高強度（重試前短發散的 `diverge` 階段例外：預設 low，不隨任務難度或失敗次數升級）。若分配到的 agent 沒有足夠強度的模型，會選它最強的模型並提示。這些強度是你對模型能力的設定，不由 CLI 自動評分。

### 推理強度（effort）

Claude Code 與 Codex 支援指定推理強度，Gemini CLI 與 `command` 不支援（設定了會在載入時報錯）。可設在兩個地方：

- `agents.<名稱>.effort`：該 agent 的預設，`balanced` 模式直接使用；`adaptive` 模式下，模型沒有自己的 effort 時也沿用它。
- `agents.<名稱>.models[].effort`：該模型被選中時使用，優先於 agent 的 `effort`。

```bash
agentflowctl config agent set claude --effort medium
agentflowctl config agent model add claude MODEL_NAME --strength high --effort high
agentflowctl config agent model set claude MODEL_NAME --effort low     # 只改 effort；--effort none 清除
agentflowctl config agent model add claude MODEL_NAME --strength medium --effort medium   # 同一個模型可用不同強度各登記一筆
agentflowctl config agent model set claude MODEL_NAME --at high --effort xhigh            # 同名有多筆時用 --at 指定目前強度
agentflowctl config agent model remove claude MODEL_NAME --at medium
```

同一個 agent 的 `models` 以「名稱＋強度」為唯一鍵：同名模型可以用不同強度（通常搭配不同 effort）各登記一筆，同名同強度則視為重複。`model set` 與 `model remove` 遇到同名多筆時，必須用 `--at <強度>` 指定要動哪一筆。

Claude Code 以 `--effort <值>` 傳入，Codex 以 `-c model_reasoning_effort="<值>"` 傳入，放在 `extraArgs` 之前。可用的值由各 CLI 決定（例如 Claude Code 的 `low`、`medium`、`high`、`xhigh`、`max`），agentflowctl 只檢查非空，`config agent model add` 與 `config agent model check` 會連同 effort 一起送出探測請求，值不合法時會失敗。`adaptive` 模式下 `extraArgs` 不可再放 `--effort`，Codex 也不可透過 `-c` 或 `--config` 設定 `model_reasoning_effort`（包含參數合併形式），避免覆寫選定的 effort；其他 config 參數仍可使用。終端機每次呼叫會在模型名稱後顯示 `（effort …）`，log 檔頭也會記錄；`config agent list` 與 `config agent model list` 會列出設定的 effort。

### 模型驗證

Claude Code 預設會載入你的使用者層設定（plugin、SessionStart hook 等），每次呼叫都會多讀這些內容；想讓 agent 只用專案設定，可在該 agent 的 `extraArgs` 加 `["--setting-sources", "project,local"]`（agentflowctl 自己的 `--settings` 檔仍會生效，但使用者層的 plugin、hook 與其他設定都不會載入，請依需求取捨）。

Claude Code、Codex 與 Gemini CLI 都使用專用探測流程：以 `--model` 指定模型，在獨立暫存目錄要求「只回答 OK」，不沿用正常工作時的 `extraArgs`。

| CLI | 探測時的工具限制 |
|---|---|
| Claude Code | `--tools ""` 停用內建工具，`--strict-mcp-config` 不載入外部 MCP，`--disable-slash-commands` 停用 slash commands |
| Codex | 唯讀沙箱與 `approval_policy="never"` 禁止寫入及權限升級；停用 shell、外部工具與 hooks，忽略使用者設定及 rules。仍可能有模型內建檔案工具，由唯讀沙箱限制 |
| Gemini CLI | admin/user policy 禁止所有工具（合法優先級 `999`），停用 extensions、MCP 與 hooks；政策載入問題使驗證失敗 |

三家共用相同的通過條件：CLI 結束碼為 0、有非空文字與成功完成事件，且沒有工具嘗試或失敗事件。即使後來回覆成功，先前的失敗也不會被忽略。

探測上限為 30 秒，結束後清除暫存目錄；macOS／Linux 逾時或按 Ctrl-C 中斷時會停止整個程序群組，包含 CLI 啟動的子程序。`config agent model add` 成功才新增模型，失敗保持設定原狀；`config agent model check` 只重驗、不修改設定。CLI 不支援探測參數（版本過舊或參數已改名）時直接失敗並提示更新 CLI，不會改用更寬鬆的權限重試。

Codex 另有幾點差異：
- 只寫在 stderr 的工具拒絕（例如唯讀沙箱擋下 patch）同樣算失敗。
- Codex 的 `error` item 是非致命通知，例如找不到模型 metadata 改用預設值、設定警告、棄用提示，不影響探測與 run 結果；`logs` 以 ⚠️ 顯示，不列入錯誤段落。真正的失敗是 `turn.failed` 與頂層 `error` 事件。
- Codex 只在模型被改派時回報實際模型，其餘情況只確認指定名稱可呼叫，不推測別名對應。
- `logs` 會顯示 Codex 每回合的完成事件，跨回合的 shell 指令分開整理。

自訂 `command` adapter 另需提供會實際呼叫模型的探測命令；設定方式與各 CLI 已查核版本見[詳細參考](docs/reference.md#模型設定與自動選模)。

## 專案設定

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
| `agents.<名稱>.effort` | 無 | 推理強度，只有 `claude` 與 `codex` 支援；`model` 項目的 `effort` 優先 |
| `agents.<名稱>.models` | 無 | 自動選模時使用；每筆有 `name`、`strength`，可加 `effort`，建議用 `config agent model add` 設定並實際驗證 |
| `fixStrategy` | `"ring"` | `"ring"` 由審查者以外的 agent 修正；`"author"` 交回最後作者 |
| `tddSplit` | `true` | 有多位 agent 時，`true` 會把同一任務的測試與實作分給不同 agent |
| `reviewQuorum` | `1` | 任務與最終程式碼審查需要幾位不同審查者核准 |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者核准 |
| `taskConcurrency` | 不限 | 沒有相依關係的任務最多幾個同時執行（各在自己的 worktree）；`1` 為一次一個任務，等同關閉平行任務；說明見[平行執行任務](#平行執行任務) |
| `checksConcurrency` | 不限 | 同一次驗證裡 typecheck、lint、test、build 等檢查最多幾個同時執行；`1` 為一次一個。install 仍先單獨跑完 |
| `reviewConcurrency` | 不限 | 同一輪審查最多幾位審查者同時執行；`1` 為一次一位；說明見表格下方，`config doctor` 會顯示目前的設定 |
| `planArbiter` | `true` | 計畫審查僵持，或修訂一次後仍被要求修改時是否啟用仲裁 |
| `planReviewLayers` | `{ "enabled": true, "minTasks": 7, "maxGroups": 5, "tasksPerGroup": 3 }` | 任務夠多時把計畫審查拆成索引與任務群；說明見表格下方 |
| `diverge` | `{ "enabled": true, "after": 2, "branches": 3 }` | 同一任務連續因測試／實作關卡失敗時，先從 2 到 3 個角度診斷再重試；說明見表格下方 |
| `tieBreak` | `"proceed"` | 兩位仲裁者意見分歧時，`"proceed"` 繼續、`"stop"` 停止 |
| `maxAgentRuns` | `60` | 計畫定案前，一次 run 最多執行幾次 agent；定案後改依任務數決定（見 `agentRunsPerTask`） |
| `agentRunsPerTask` | `20` | 計畫定案時，上限改為「已執行次數 ＋ 任務數 × 這個值」（任務數不含 `kind: confirm`）。`run`／`resume` 明確指定 `--max-agent-runs` 後不再改算 |
| `maxAttempts` | `5` | 同一關連續失敗幾次後停止，至少 3；可用 `run`／`resume` 的 `--max-attempts` 覆蓋 |
| `verbose` | `false` | 顯示 agent 文字、工具呼叫與專案指令，效果同 `-v` |
| `install`、`test` | 依專案偵測 | 寫成指令字串，例如 `"install": "pnpm install"` |
| `checks` | 依專案偵測 | 檢查清單，例如 `[{ "name": "test", "cmd": "pnpm test" }]`；提供時會取代整份預設清單。每項可加 `finalOnly: true`（每個任務的驗證跳過，只在最後整支分支的驗證才跑）與 `changedOnly: true`（最後驗證時把整支分支改過的程式檔接在指令後面，只檢查它們） |
| `testPattern` | 常見的 `.test.`、`.spec.` 檔名 | 辨識測試檔的正規表示式字串；非標準檔名時調整 |

計畫審查會依任務規模選做法。同時符合下列條件時，每輪先做一次索引審查，再只審查有變動的任務群：任務達到 `planReviewLayers.minTasks` 個；依 description 寫的檔案路徑能分成至少兩群，而且最大一群不超過三分之二；`plan.md` 每個任務都有 `## T-<數字>` 標題。索引審查讀規格、全部任務描述、驗收條件與整體做法，人數是 `planReviewQuorum`。群數最多 `maxGroups`，也不超過任務數除以 `tasksPerGroup`；每群一位審查者，含 `high` 任務的群改由 `planReviewQuorum` 位審查。改了 `plan.md` 的整體做法時所有群都重審；某一次審查失敗時只重跑還沒完成的部分。已達門檻卻不符其他條件時，終端機會印出原因並改由審查者讀完整份規格與計畫。`"planReviewLayers": { "enabled": false }` 可以關閉，`config doctor` 會顯示目前的設定。

同一個任務最近連續合格失敗剛好達到 `diverge.after` 次（分類為測試未寫、測試本身有問題、或綠燈仍未通過；不含紅燈一開始就通過）時，或 TDD 綠燈第二次失敗而退回測試時，實作階段會先跑短發散：2 到 3 個互不看見的診斷分支，再由不是卡住寫檔者的評審選一個，結論追加到 `.flow/feedback.md`（終端機顯示 `🔀`）。程式不依評審改流程，下一次寫測試或實作仍走原本關卡。第一次失敗不觸發，同一段連續失敗只發散一次（發散之後新增的失敗才重新計數）；退回測試兩次會再發散一次。這 3 到 4 次呼叫會計入 `maxAgentRuns`，而且一次實作階段內不會中途被預算打斷，緊預算時可能先碰到上限。評審額度用完而暫停時，resume 會重跑這一輪發散。可用 `"diverge": { "enabled": false }` 關閉，`config doctor` 會顯示目前的設定。adaptive 模式下這些呼叫預設用 low 強度（階段名 `diverge`），要調高就執行 `agentflowctl config selection stage diverge medium`；balanced 模式不分強度，這個設定不生效。

### 平行執行任務

實作階段開始時，若有兩個以上的任務同時可以開始（沒有 `dependsOn`，或依賴的任務都已完成），這些任務會各占一條「車道」同時執行；只有相依鏈（每個任務都依賴前一個）、或 `taskConcurrency` 設為 `1` 時，照舊一次做一個任務。可用 `taskConcurrency` 限制同時數量。

- **每條車道是一個小 run。** 車道有自己的 git worktree（`.agentflowctl/runs/<id>/lanes/<任務>/worktree`）與分支 `flow/<id>+<任務>`，起點是 run 當時的 HEAD，也有自己的 `.flow/` 與 `state.json`。任務在車道裡走和順序執行完全一樣的流程：紅燈、綠燈、任務審查、任務驗證、修正。角色輪替仍依任務在清單中的位置決定，與順序執行時一致。
- **共用的紀錄寫進所屬 run。** log、用量、重試、代打與交接帳本都記在 run 底下，所以 `logs`、`stats`、`insights` 與 `maxAgentRuns` 不需要另外合併。因此車道裡的 agent 也看得到其他車道開的交接事項。
- **合併一次一個。** 車道完成後依完成順序合併回 run 的分支（保留合併 commit，訊息 `merge(T-n): …`），合併後才解鎖依賴它的任務；車道的 worktree 與分支隨即清掉。合併後若 `package.json` 或 lockfile 變了，會在 run 的 worktree 重新安裝。
- **衝突時重做。** 和已合併的任務在同一處衝突時，這條車道會回到最新的分支、從寫測試重做（重試分類 `merge_conflict`，次數計入 `maxAttempts`）。計畫與計畫審查的 prompt 都要求：會修改同一個檔案、或用到另一個任務新增內容的任務必須用 `dependsOn` 排出先後。語意上的衝突（沒有文字衝突但合在一起壞掉）由最後的整體驗證與程式碼審查把關。
- **車道裡不安裝相依套件。** 車道的 `node_modules` 是指向 run 的 symlink，各自安裝會互相覆寫，所以車道裡只跑測試與 build 等檢查；新增相依套件的任務，合併後才會在 run 裡安裝。
- **失敗、暫停與 resume。** 任一車道失敗（重試達上限、agent 次數用完）就不再開新車道，已在跑的跑完並合併，run 以失敗結束，原因會寫明是哪個任務。額度用完同理：額度是 agent 層級的，用同一家 agent 的車道也會一起暫停，其餘車道跑完後 run 暫停。`resume` 時已合併的任務不重做，失敗或暫停的車道接續。
- `maxAgentRuns` 是整個 run 所有車道合計的次數；平行時可能略微超出（最多多出同時執行的車道數）。
- `status` 在任務清單裡標出正在平行執行的任務。

### 平行審查

同一輪的審查者（整份計畫審查、分層計畫審查的索引與各群、程式碼審查）預設同時執行，可用 `reviewConcurrency` 限制同時數量（`1` 為一次一位）。

**審查者的環境**

- 每位審查者在自己的臨時 git worktree 裡工作，固定放在 `.agentflowctl/runs/<id>/tmp-review/slot-<N>/`；只有該路徑被占用（例如上次中斷的殘骸）時才改用唯一的子目錄。
- 看到的是 run 目前的 HEAD、`.flow/` 的複本，以及指向 run worktree 頂層 `node_modules` 的 symlink（有才建）；不含其他未 commit 或被 gitignore 的檔案（例如 `dist/`）。所以審查者改了什麼都不會影響 run 的 worktree 或其他審查者。
- 唯一的例外是 `node_modules`：它是共用的 symlink，審查者若在臨時 worktree 裡跑安裝，會寫到 run 真正的 `node_modules`。
- 程式碼審查開始前，會先把 run 的 worktree 還原成 HEAD（清掉驗證階段留下的未 commit 修改與未追蹤產物）。

**結果如何套用**

- 審查結果一完成就存進 `.agentflowctl/runs/<id>/parallel-review/`，全部審查者跑完後才依固定順序逐一套用結果與交接事項。
- 因此即使 `reviewConcurrency` 為 `1`，同一輪的審查者也看不到彼此本輪新增或結掉的交接事項，核准與否也依它開始時看到的帳本判斷。例如一位審查者結掉了某個未結事項，另一位核准卻沒有結掉它，後者會被判交接不合格而多重跑一次（重跑時就看得到該事項已結）。
- 同時執行時，引擎印出的訊息會加上 `[審查者]` 前綴；agent 自己的輸出（`-v` 時印出的內容、回報的疑慮）不加。

**中斷與 resume**

- 任何時候 Ctrl-C 或被中斷，之後 `resume` 只會補跑沒完成的審查者，已完成的不重跑。
- 已存檔的審查只在同一輪、計畫或程式碼沒變，而且交接帳本沒有被這一輪以外的呼叫（例如修正者）動過時沿用，否則重審。
- 中斷留下的臨時 worktree（`.agentflowctl/runs/<id>/tmp-review/`）在該 run 下次 `resume`（或 `clean`）時自動清掉。

**額度與預算**

- 若有審查者的額度用完，其他審查者仍會跑完並存檔，全部結束後才暫停；但同一家 agent 還沒啟動的審查者也會略過（這家在這次執行中已確認額度用完），`resume` 時再和額度用完的那位一起補跑。
- 審查只在 `maxAgentRuns` 剩餘的次數內啟動：預算不夠整輪時只啟動預算內的審查者（結果照樣存檔），run 以 `agent_budget` 失敗，用 `resume <id> --max-agent-runs <次數>` 調高後只補跑沒跑的。

審查意見的處理寫在 `.flow/plan-replies.md`，每輪覆寫，不寫進 `plan.md` 文末。下一輪索引會看到整份回應；任務群只看到自己的 `## T-<數字>` 節。

`install`、`test`、`checks` 未設定時，會依 `packageManager`、lockfile 和 `package.json` scripts 偵測。完整範例見 [examples/flow.config.json](examples/flow.config.json)。專案設定每一步都會重新讀取，但已建立 run 的參與 agent 與執行次數上限會沿用建立時的值；要調高後者請用 `resume --max-agent-runs`。

agentflowctl 不讀取任何 `AGENTFLOWCTL_*` 環境變數，設定都寫在 `flow.config.json`。`maxAttempts`（預設 5、至少 3；設得更小會直接報設定錯誤）是單一關卡的重試上限（至少 3），單一 run 可用 `run`／`resume` 的 `--max-attempts` 覆蓋；計畫審查何時交付仲裁與它無關：意見沒有變化，或第 2 輪（修訂過一次）仍被要求修改時就交付，兩家 agent 時自動進入雙盲交叉仲裁，有第三方時由第三方單獨仲裁；`maxAgentRuns` 則是整次 run 的 agent 執行次數上限。修正成功、或計畫審查與程式碼審查整組完成一輪有效審查後，該關的失敗次數會歸零，所以上限只計算連續失敗。分層計畫審查時，同一輪裡只要有一次審查呼叫真的執行成功，計畫審查的失敗次數也會歸零；所以索引與各群輪流各失敗一次、每次重跑都有進展時，不會因累計達上限而失敗。
