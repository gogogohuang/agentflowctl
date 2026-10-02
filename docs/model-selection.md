# 模型設定與自動選模

依階段與任務難度自動選模、推理強度（effort）與模型驗證。[回 README](../README.md)

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

計畫 agent 會查閱相關程式碼，依影響範圍、技術不確定性與失敗後果為每個任務標註 `low`／`medium`／`high` 難度，取三者中最高等級，並在計畫中寫出依據；計畫審查會逐項核對。自動選模先遵守角色分配，再取階段強度與任務難度中較高者；失敗重試會提高強度。若分配到的 agent 沒有足夠強度的模型，會選它最強的模型並提示。這些強度是你對模型能力的設定，不由 CLI 自動評分。

### 推理強度（effort）

Claude Code 與 Codex 支援指定推理強度，Gemini CLI 與 `command` 不支援（設定了會在載入時報錯）。可設在兩個地方：

- `agents.<名稱>.effort`：該 agent 的預設，`balanced` 模式直接使用；`adaptive` 模式下，模型沒有自己的 effort 時也沿用它。
- `agents.<名稱>.models[].effort`：該模型被選中時使用，優先於 agent 的 `effort`。

```bash
agentflowctl config agent set claude --effort medium
agentflowctl config agent model add claude MODEL_NAME --strength high --effort high
agentflowctl config agent model set claude MODEL_NAME --effort low     # 只改 effort；--effort none 清除
```

Claude Code 以 `--effort <值>` 傳入，Codex 以 `-c model_reasoning_effort="<值>"` 傳入，放在 `extraArgs` 之前。可用的值由各 CLI 決定（例如 Claude Code 的 `low`、`medium`、`high`、`xhigh`、`max`），agentflowctl 只檢查非空，`config agent model add` 與 `config agent model check` 會連同 effort 一起送出探測請求，值不合法時會失敗。`adaptive` 模式下 `extraArgs` 不可再放 `--effort`，Codex 也不可透過 `-c` 或 `--config` 設定 `model_reasoning_effort`（包含參數合併形式），避免覆寫選定的 effort；其他 config 參數仍可使用。終端機每次呼叫會在模型名稱後顯示 `（effort …）`，log 檔頭也會記錄；`config agent list` 與 `config agent model list` 會列出設定的 effort。

### 模型驗證

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

自訂 `command` adapter 另需提供會實際呼叫模型的探測命令；設定方式與各 CLI 已查核版本見[詳細參考](reference.md#模型設定與自動選模)。
