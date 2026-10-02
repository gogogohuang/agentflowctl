# 指令與設定

指令分層、`run`／`resume` 選項、agent 設定與 `flow.config.json` 欄位。模型與 effort 見 [模型設定](model-selection.md)，平行執行見 [平行執行](parallel.md)。[回 README](../README.md)

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
| `replan <id> --note <文字>`／`--note-file <路徑>`／`--no-review` | 補充意見或手改計畫檔後重做計畫，見 [執行流程](workflow.md)；`--no-review` 改完不再送審 |
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
| `taskConcurrency` | 不限 | 沒有相依關係的任務最多幾個同時執行（各在自己的 worktree）；`1` 為一次一個任務，等同關閉平行任務；說明見 [平行執行](parallel.md) |
| `checksConcurrency` | 不限 | 同一次驗證裡 typecheck、lint、test、build 等檢查最多幾個同時執行；`1` 為一次一個。install 仍先單獨跑完 |
| `reviewConcurrency` | 不限 | 同一輪審查最多幾位審查者同時執行；`1` 為一次一位；說明見表格下方，`config doctor` 會顯示目前的設定 |
| `planArbiter` | `true` | 計畫審查僵持，或修訂一次後仍被要求修改時是否啟用仲裁 |
| `planReviewLayers` | `{ "enabled": true, "minTasks": 7, "maxGroups": 5, "tasksPerGroup": 3 }` | 任務夠多時把計畫審查拆成索引與任務群；說明見表格下方 |
| `tieBreak` | `"proceed"` | 兩位仲裁者意見分歧時，`"proceed"` 繼續、`"stop"` 停止 |
| `maxAgentRuns` | `60` | 計畫定案前，一次 run 最多執行幾次 agent；定案後改依任務數決定（見 `agentRunsPerTask`） |
| `agentRunsPerTask` | `20` | 計畫定案時，上限改為「已執行次數 ＋ 任務數 × 這個值」（任務數不含 `kind: confirm`）。`run`／`resume` 明確指定 `--max-agent-runs` 後不再改算 |
| `maxAttempts` | `5` | 同一關連續失敗幾次後停止，至少 3；可用 `run`／`resume` 的 `--max-attempts` 覆蓋 |
| `verbose` | `false` | 顯示 agent 文字、工具呼叫與專案指令，效果同 `-v` |
| `install`、`test` | 依專案偵測 | 寫成指令字串，例如 `"install": "pnpm install"` |
| `checks` | 依專案偵測 | 檢查清單，例如 `[{ "name": "test", "cmd": "pnpm test" }]`；提供時會取代整份預設清單。每項可加 `finalOnly: true`（每個任務的驗證跳過，只在最後整支分支的驗證才跑）與 `changedOnly: true`（最後驗證時把整支分支改過的程式檔接在指令後面，只檢查它們） |
| `testPattern` | 常見的 `.test.`、`.spec.` 檔名 | 辨識測試檔的正規表示式字串；非標準檔名時調整 |

計畫審查會依任務規模選做法。同時符合下列條件時，每輪先做一次索引審查，再只審查有變動的任務群：任務達到 `planReviewLayers.minTasks` 個；依 description 寫的檔案路徑能分成至少兩群，而且最大一群不超過三分之二；`plan.md` 每個任務都有 `## T-<數字>` 標題。索引審查讀規格、全部任務描述、驗收條件與整體做法，人數是 `planReviewQuorum`。群數最多 `maxGroups`，也不超過任務數除以 `tasksPerGroup`；每群一位審查者，含 `high` 任務的群改由 `planReviewQuorum` 位審查。改了 `plan.md` 的整體做法時所有群都重審；某一次審查失敗時只重跑還沒完成的部分。已達門檻卻不符其他條件時，終端機會印出原因並改由審查者讀完整份規格與計畫。`"planReviewLayers": { "enabled": false }` 可以關閉，`config doctor` 會顯示目前的設定。

審查意見的處理寫在 `.flow/plan-replies.md`，每輪覆寫，不寫進 `plan.md` 文末。下一輪索引會看到整份回應；任務群只看到自己的 `## T-<數字>` 節。

`install`、`test`、`checks` 未設定時，會依 `packageManager`、lockfile 和 `package.json` scripts 偵測。完整範例見 [examples/flow.config.json](../examples/flow.config.json)。專案設定每一步都會重新讀取，但已建立 run 的參與 agent 與執行次數上限會沿用建立時的值；要調高後者請用 `resume --max-agent-runs`。

agentflowctl 不讀取任何 `AGENTFLOWCTL_*` 環境變數，設定都寫在 `flow.config.json`。`maxAttempts`（預設 5、至少 3；設得更小會直接報設定錯誤）是單一關卡的重試上限（至少 3），單一 run 可用 `run`／`resume` 的 `--max-attempts` 覆蓋；計畫審查何時交付仲裁與它無關：意見沒有變化，或第 2 輪（修訂過一次）仍被要求修改時就交付，兩家 agent 時自動進入雙盲交叉仲裁，有第三方時由第三方單獨仲裁；`maxAgentRuns` 則是整次 run 的 agent 執行次數上限。修正成功、或計畫審查與程式碼審查整組完成一輪有效審查後，該關的失敗次數會歸零，所以上限只計算連續失敗。分層計畫審查時，同一輪裡只要有一次審查呼叫真的執行成功，計畫審查的失敗次數也會歸零；所以索引與各群輪流各失敗一次、每次重跑都有進展時，不會因累計達上限而失敗。
