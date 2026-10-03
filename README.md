# agentflowctl

[![npm version](https://img.shields.io/npm/v/agentflowctl.svg)](https://www.npmjs.com/package/agentflowctl)

讓 Claude Code、Codex、Gemini CLI 等 agent 在同一個專案裡分工：整理需求、規劃、寫測試與程式、交叉審查，最後建立 PR。agentflowctl 負責推進流程，並用檔案、測試和檢查結果決定能否進到下一步。

每次執行都會建立獨立的 git worktree 與 `flow/<id>` 分支，不會直接修改你目前的工作目錄。兩個 agent 就能運作；只有一個也能執行，但無法跨 agent 審查。

## 開始使用

需要 **Node.js 22 以上**、git，以及至少一個已安裝且完成登入的 agent CLI（Claude Code、Codex、Gemini CLI；建議準備兩個）。

在要開發的專案根目錄執行：

```bash
npx agentflowctl config agent setup    # 選擇 agent 與模型模式，寫入 flow.config.json
npx agentflowctl config doctor         # 檢查設定與 CLI 是否可執行
npx agentflowctl run --req "登入表單加入驗證與錯誤訊息"
```

需求寫在檔案裡時，改用 `--req-file ./requirement.md`。下文以 `agentflowctl` 為例；未全域安裝時，在指令前加 `npx`，或執行 `npm install -g agentflowctl`。

## 一次 run 做什麼

需求 → 規格 → 計畫與計畫審查 → 逐任務寫測試、寫實作、審查、驗證 → 整體檢查與程式碼審查 → 推送分支並建立 PR（沒有 `origin` 時，分支留在本機）。

每道程式碼審查都要逐條回報驗收條件（漏掉、或寫出不存在的編號會重審），審查者另外提出的問題必須附證據，且只在第一次審查時能擋關；修正若新增 `skip`、`@ts-ignore`、`eslint-disable` 或讓斷言變少會被退回。計畫仲裁意見分歧而繼續實作時，沒核准的意見會變成最終審查必須處理的待辦事項。作者回覆裡標出的疑慮會交給審查者優先查證；審查也會檢查有沒有驗收條件都不需要的過度實作。檢查（typecheck、lint、test 等）第一次失敗時會先原樣重跑一次，第二次通過視為不穩定（flaky）而放行並記錄，兩次都失敗才交給修正者（`rerunFailedChecks` 可關閉）。沒有相依關係的任務若在計畫裡描述同一個檔案，計畫會被退回，要求排出先後。`agentflowctl insights` 會列出反覆出現的失敗類別與對應該檢查的規則，以及不穩定的檢查。

範圍小的需求可以加 `--fast`：一次 agent 呼叫寫完規格與計畫（任務最多 2 個），略過計畫審查與任務審查，其餘（紅綠燈、驗證、整體程式碼審查、PR）照舊。agent 會一併回報這個需求是否跨模組、動到公開介面或儲存格式、碰到信任邊界、有未決的重要設計；任何一項成立，或計畫帶著未結的交接事項，就丟掉這份計畫改走完整流程（多花一次 agent 呼叫）。

流程預設自動往下走。想在計畫通過審查後先確認，加 `--manual-plan`，確認後執行 `agentflowctl approve <id>`。計畫有疑慮時：

```bash
agentflowctl replan <id> --note "T-2 要改用既有的 helper"   # 補充意見，只改相關任務
agentflowctl replan <id>                                    # 手改 .flow/ 的計畫檔後重新檢查（人工確認項目會先併回 .flow/，改完依計畫檔重建清單）
```

run 完成後還想再改：`agentflowctl iterate <id> --req "改用既有的 helper"` 會在同一個 worktree 與分支上開第二輪（補充需求從 spec 重來，程式碼與 PR 沿用，推送後更新同一個 PR；PR 已合併則改用 `run`）。

**修補任務**：後面的任務發現必須改變已合併任務的行為時，agent 會寫 `.flow/amend-request.json`。引擎檢查格式、目標是否已合併與次數上限後，插入一個依賴該任務的修補任務（`kind: "amend"`，走完整的紅燈、綠燈、任務審查、任務驗證），請求者丟棄半成品，等修補合併後從最新的分支重做；修補任務會讓 agent 執行次數上限加上 `agentRunsPerTask`（明確指定 `--max-agent-runs` 時不加）。請求不合格（格式錯誤、目標不存在或尚未合併）時，原因會以 `amend_invalid` 類別經 feedback 退回請求者重寫。達到 `maxAmendments`（同一個已合併任務最多被修補幾次，預設 2）時 run 暫停，並告知請求者改在自己的任務內完成、或把問題寫進 `newIssues`；`resume` 前請檢查 `.flow/feedback.md`（停在實作階段無法 `replan`）。修補任務合併後，同一內容的請求會被當成新請求並計入次數。

要在某階段先取用產出，用 `--stop-after <spec|plan|implement|verify|review|pr>`，之後 `resume <id>` 接續。

各階段的規則見[執行流程細節](docs/workflow.md)。

## 查看進度

`run` 開始時會印出 run id（例如 `f-xxxx`）。執行中預設只顯示階段進度；加 `-v` 可看到 agent 文字、工具呼叫與專案指令。

```bash
agentflowctl list                  # 列出 run
agentflowctl status f-xxxx         # 進度、結果與下一步
agentflowctl confirmations f-xxxx  # 只列出需要人眼確認的任務
agentflowctl logs f-xxxx           # 各步驟的 log；加 --latest 看最新一份
agentflowctl stats f-xxxx          # 各步驟耗時、執行與失敗次數
agentflowctl insights              # 整個專案所有 run 的結果、失敗原因、用量與建議
agentflowctl resume f-xxxx         # 從暫停、中斷或失敗處接續
agentflowctl cancel f-xxxx         # 放棄
agentflowctl clean f-xxxx          # 清除 worktree 與紀錄（clean --all 清所有 done／failed）；flow/<id> 分支會保留
```

各指令輸出的說明見[查看進度與停下來時的處理細節](docs/monitoring.md)。

## 執行停下來時怎麼做

先執行 `agentflowctl status <id>`，看「階段」與「原因」：

| 狀況 | 下一步 |
| --- | --- |
| 按 Ctrl-C，或終端機意外關閉 | `agentflowctl resume <id>` |
| `awaiting_approval`：計畫等你確認 | 閱讀 `.agentflowctl/worktrees/<id>/.flow/plan.md`，確認後 `agentflowctl approve <id>`；有疑慮就 `replan` |
| `paused`：agent 額度用完 | 等額度恢復後 `agentflowctl resume <id>` |
| `paused`：已完成指定停點 | 檢視產出後 `agentflowctl resume <id>` |
| `failed`：測試、檢查、審查或 agent 執行失敗 | 用 `agentflowctl logs <id> <編號>` 查原因，處理後 `agentflowctl resume <id>` |
| `failed`：仲裁連續沒有有效裁決 | 查看 log 後 `agentflowctl resume <id>` |
| `failed`：已達 agent 執行次數上限 | `agentflowctl resume <id> --max-agent-runs 100`（數字須大於已執行次數；額度用完而失敗的呼叫也計入，平行的車道與審查者合計不會超出上限） |

## 常用選項

| 選項 | 用途 |
| --- | --- |
| `run --req "..."` / `--req-file <檔案>` | 二選一，直接輸入需求或讀取檔案 |
| `run --manual-plan` | 計畫通過審查後等你確認，再 `approve <id>` |
| `run --fast` | 快速流程：一次寫完規格與計畫、略過計畫審查與任務審查；計畫標出複雜度時自動改走完整流程 |
| `run --stop-after <階段>` | 在指定階段完成後暫停；與 `--manual-plan` 互斥 |
| `run --cycle claude,codex` | 指定這次參與的 agent |
| `run --model-mode balanced\|adaptive` | 只覆蓋這次的模型模式 |
| `run --base <分支>` | 指定起始分支；未設定時使用目前分支 |
| `run --max-attempts <次數>` | 覆蓋重試上限（至少 3，預設 5）；`resume` 也可用 |
| `run --max-agent-runs <次數>` | 指定 agent 執行次數上限；`resume` 也可用 |
| `-v` / `--verbose` | 顯示 agent 文字、工具呼叫與專案指令 |

```bash
agentflowctl run --req-file ./requirement.md --cycle claude,codex --manual-plan
agentflowctl resume f-xxxx --max-agent-runs 100
```

## 設定

專案設定放在專案根目錄的 `flow.config.json`，沒寫的欄位用預設值。最小範例：

```json
{
  "agents": {
    "claude": { "adapter": "claude" },
    "codex": { "adapter": "codex", "model": "你要用的模型" }
  },
  "cycle": ["claude", "codex"]
}
```

也可以用指令管理 agent：

```bash
agentflowctl config agent list
agentflowctl config agent add codex --adapter codex --model 你要用的模型
agentflowctl config agent cycle claude,codex
agentflowctl config selection mode adaptive    # 依階段與任務難度自動選模；需先登記各 agent 的模型
```

`install`、`test`、`checks` 未設定時會依專案自動偵測。偵測到的 vitest 會略過 `.worktree/` 與 `.worktrees/`；eslint 的 lint 會略過 `.flow/`、`.agentflowctl/`、`.worktree/`、`.worktrees/`。完整欄位、自動選模、推理強度、平行執行與模型驗證見[設定詳解](docs/configuration.md)，範例見 [examples/flow.config.json](examples/flow.config.json)。

## 更多文件

- [執行流程細節](docs/workflow.md)：驗收條件原則、紅綠燈規則、`replan`、停點與專案指令偵測。
- [查看進度與停下來時的處理細節](docs/monitoring.md)：`status`、`stats`、`insights` 的輸出與交接事項規則。
- [設定詳解](docs/configuration.md)：指令與選項、agent、選模、專案設定欄位、平行任務與平行審查。
- [完整指令、設定與流程說明](docs/reference.md)：角色分配、審查規則、log、額度處理與技術細節。
- [各階段讀寫的檔案](docs/engine-stage-files.md)：`.flow/`、回饋與審查檔案如何交接。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
