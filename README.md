# agentflowctl

[![npm version](https://img.shields.io/npm/v/agentflowctl.svg)](https://www.npmjs.com/package/agentflowctl)

讓 Claude Code、Codex、Gemini CLI 等 agent 在同一個專案裡分工：整理需求、規劃、寫測試與程式、交叉審查，最後建立 PR。agentflowctl 負責推進流程，並用檔案、測試和檢查結果決定能否進到下一步。

- 內建支援 **Claude Code、Codex、Gemini CLI**；其他 CLI 可用 `command` adapter 接入。
- 每次執行都在獨立的 git worktree 與 `flow/<id>` 分支裡進行，不會動到你目前的工作目錄。
- 兩個以上的 agent 才能跨 agent 審查；只有一個也能跑。

## 快速開始

需要 **Node.js 22 以上**、git，以及至少一個已安裝並登入的 agent CLI（建議兩個，例如 Claude Code 與 Codex）。在要開發的專案根目錄執行：

```bash
npx agentflowctl config agent setup     # 選擇 agent 與模型模式，寫入 flow.config.json
npx agentflowctl config doctor          # 檢查設定與 CLI 是否可執行
npx agentflowctl run --req "登入表單加入驗證與錯誤訊息"
```

需求寫在檔案裡時改用 `run --req-file ./requirement.md`。沒有預設 agent，第一次使用要先跑 `config agent setup`。想全域安裝可執行 `npm install -g agentflowctl`；下文以 `agentflowctl` 為例，未全域安裝時在前面加 `npx`。

## 流程概覽

1. **規格與計畫**：agent 整理需求與驗收條件，寫出任務計畫，由其他 agent 審查；僵持時交給仲裁。
2. **逐個任務實作**：一位 agent 寫會失敗的測試，另一位實作到通過，再經過任務審查與驗證。沒有相依的任務會平行執行。
3. **整體檢查**：跑專案的測試與檢查，再做整體程式碼審查，未通過的項目交回修正。
4. **開 PR**：有 `origin` 時推送分支，`gh` 可用就建立 PR。

通過與否一律由程式依測試、檢查結果與 git diff 判斷，不看 agent 自己怎麼說。詳細規則見 [執行流程](docs/workflow.md)。

預設全自動往下走。想在計畫通過後親自確認，加 `--manual-plan`，確認後 `agentflowctl approve <id>`；計畫有疑慮時用 `replan` 補充意見或手改計畫檔，不必整份重寫（見 [執行流程](docs/workflow.md)）。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `run --req "…"` / `--req-file <檔>` | 開始一次 run，會印出 run id（`f-xxxx`） |
| `list` | 列出 run |
| `status <id>` | 看進度、結果與下一步 |
| `logs <id> [編號]` | 看各步驟的 log |
| `resume <id>` | 從暫停、中斷或失敗處接續 |
| `approve <id>` | 核准計畫並開始實作（搭配 `--manual-plan`） |
| `replan <id> [--note "…"]` | 補充意見或手改計畫檔後重做計畫 |
| `cancel <id>`／`clean <id>` | 放棄一個 run／清除它的 worktree 與紀錄 |
| `stats <id>`／`insights` | 單一 run 的耗時／所有 run 的結果、用量與建議 |
| `config …` | 設定 agent、模型與環境檢查 |

加 `-v` 可看到 agent 文字、工具呼叫與專案指令。所有選項見 [指令與設定](docs/configuration.md)。

## run 停下來時

先執行 `agentflowctl status <id>` 看階段與原因：

| 狀況 | 下一步 |
| --- | --- |
| Ctrl-C 或終端機關閉 | `resume <id>` |
| `awaiting_approval` | 看 `plan.md` 後 `approve <id>`，有疑慮就 `replan <id>` |
| `paused`：額度用完／到達停點 | 額度恢復或檢視產出後 `resume <id>` |
| `failed`：測試、檢查、審查或 agent 失敗 | 看 `logs <id>` 處理原因後 `resume <id>` |
| `failed`：達 agent 次數上限 | `resume <id> --max-agent-runs 100` |

完整對照與交接事項規則見 [查看進度與處理停下來的 run](docs/monitoring.md)。

## 設定

專案設定放在專案根目錄的 `flow.config.json`，沒寫的欄位用預設值；`install`、`test`、`checks` 會依 `packageManager`、lockfile 與 `package.json` scripts 自動偵測。最小範例：

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

agentflowctl 不讀取任何環境變數，設定都在 `flow.config.json`。欄位表見 [指令與設定](docs/configuration.md)，完整範例見 [examples/flow.config.json](examples/flow.config.json)。

## 文件

| 文件 | 內容 |
| --- | --- |
| [執行流程](docs/workflow.md) | 驗收條件、TDD 任務、人工確認、`replan`、停點、專案指令偵測 |
| [查看進度與處理停下來的 run](docs/monitoring.md) | `status`／`logs`／`stats`／`insights`、各種停下來的處理、清理 |
| [指令與設定](docs/configuration.md) | 指令分層、選項、agent 設定、`flow.config.json` 欄位 |
| [模型設定與自動選模](docs/model-selection.md) | 依階段與難度選模、推理強度（effort）、模型驗證 |
| [平行執行](docs/parallel.md) | 平行任務（車道）與平行審查 |
| [完整參考](docs/reference.md) | 角色分配、審查規則、log、額度處理與技術細節 |
| [各階段檔案](docs/engine-stage-files.md) | `.flow/`、回饋與審查檔案如何交接 |
| [發版（維護者）](docs/releasing.md) | `pnpm release` 流程 |

## 授權

MIT，詳見 [LICENSE](LICENSE)。
