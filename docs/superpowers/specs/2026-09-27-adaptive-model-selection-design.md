# 依階段與任務難度自動選模

## 目的與已確認的選擇

使用者先登記每個 agent 可用的模型及強度，並自行選擇是否啟用自動選模。每次呼叫 LLM 前，agentflowctl 依流程步驟、task 難度與重試次數，從**已分配角色的 agent** 可用模型中挑選最適合的一個。既有測試、實作、審查、仲裁與修正的分工規則優先。計畫 agent 在 `tasks.json` 標註 task 難度；階段強度有預設且可覆蓋。每次 LLM 步驟的終端機進度輸出須顯示實際模型。

目標是減少高強度模型的使用及實際 token 總數。選模不額外呼叫 LLM 判斷難度，失敗重試時升級強度，並記錄實際用量供比較。模型路由本身不能保證每次 run 的 token 總數必然下降。

## 方案選擇

採用「每個 agent 有模型清單」：`cycle` 與 `roles.ts` 先決定負責的 agent，再由規則式選模器決定該 agent 本次使用的模型。這讓 verify 修正仍能交回作者，審查者仍是另一位 agent。沒有採用「每個模型當獨立 agent」方案，因為它需要重寫跨別名的作者與審查者判斷；也沒有採用每步另請 LLM 判斷難度的方案，因為它會增加 token 與失敗點。

## 設定與 CLI

模型強度設定在 `flow.config.json` 的 `agents.<名稱>.models`，每筆填 `name`、`strength`。強度只有 `low`、`medium`、`high`；清單順序是同強度模型的優先順序。`modelSelection.stageStrength` 可逐步驟覆蓋強度預設。

```json
{
  "agents": {
    "claude": {
      "adapter": "claude",
      "models": [
        { "name": "使用者可用的輕量模型", "strength": "low" },
        { "name": "使用者可用的強力模型", "strength": "high" }
      ]
    },
    "codex": {
      "adapter": "codex",
      "models": [
        { "name": "使用者可用的一般模型", "strength": "medium" },
        { "name": "使用者可用的強力模型", "strength": "high" }
      ]
    }
  },
  "cycle": ["claude", "codex"],
  "modelSelection": {
    "mode": "adaptive",
    "stageStrength": { "taskReview": "high" }
  }
}
```

`modelSelection.mode` 為 `balanced` 或 `adaptive`，預設 `balanced`。`run --model-mode balanced|adaptive` 可覆蓋這次 run，選定的 mode 存入 `state.json`，resume 沿用。舊的 `agents.<name>.model` 與 `defaultModels` 在 `balanced` 模式繼續生效，不需遷移。`adaptive` 啟動前要求本次 `cycle` 的每個 agent 至少登記一個模型，且同一 agent 的模型名稱不重複。`agent add`／`agent set` 原有 `--model` 行為不變；使用者可直接編輯 JSON 的模型清單，由 `RepoConfig` 驗證。

`command` adapter 在 `adaptive` 模式須在 `command` 參數陣列使用 `{model}` 占位符，執行時代入所選模型；缺少占位符就報設定錯誤。原有 `{prompt}`／stdin 行為保持。

## 階段強度與 task 難度

| 設定鍵 | LLM 步驟 | 預設 |
| --- | --- | --- |
| `spec` | 寫規格 | `medium` |
| `plan` | 拆任務 | `high` |
| `planReview` | 計畫審查 | `high` |
| `planFix` | 修改計畫 | `medium` |
| `planArbiter` | 仲裁 | `high` |
| `taskTests` | 任務寫測試 | `low` |
| `taskCode` | 任務實作 | `low` |
| `taskReview` | 任務審查 | `medium` |
| `taskFix` | 任務修正 | `low` |
| `fix` | 整體修正 | `medium` |
| `review` | 整體審查 | `high` |

`verify`、任務驗證、`pr` 沒有 LLM 呼叫，不提供模型設定。計畫 prompt 要求每個 task 新增 `complexity: "low" | "medium" | "high"`，依影響範圍與技術不確定性標註；計畫審查與計畫修正要檢查並保留它。新 `adaptive` run 的計畫驗證要求每個 task 都有合法難度。舊 run 的 task 若缺少難度，讀取時視為 `medium`，確保可 resume。難度只供選模，不取代檔案、diff、測試與審查 JSON 等機械關卡。

與 task 有關的寫測試、實作、任務審查、任務修正，目標強度是 `max(階段強度, task.complexity)`；其他 LLM 步驟只取階段強度。

## 呼叫前選模與失敗處理

1. `roles.ts` 先依 `cycle`、seed、作者／審查者排除規則分配 agent。模型強度不改變 `tddSplit`、審查 quorum、`fixStrategy` 或仲裁小組。
2. 對同一邏輯步驟的執行或輸出驗證失敗，依既有 `attempts` 每次將目標強度提高一級，最多 `high`。審查要求修改後面對新內容的下一輪審查重新從基準強度起算。
3. 在該 agent 的清單中選「強度足夠且最低」的模型；同強度依清單順序。若沒有足夠強度，選最強的已登記模型，在終端機提示強度不足。相同 run 狀態與設定在 resume 時得到相同選擇。
4. `agentStep()` 把選中模型交給 adapter，終端機每次顯示 `agent`、模型名稱與是否低於目標；log 檔頭與用量紀錄也保存實際模型。預設安靜模式仍要印這一行，`-v` 照舊額外印文字與工具呼叫。`balanced` 也顯示本次的 `model`／`defaultModels`；兩者都沒設定時顯示「CLI 預設（名稱未知）」。

額度不足沿用現行政策：審查暫停，寫入呼叫先還原半成品再換另一位有額度的 agent；代打 agent 從自己的清單重新選模。`fixStrategy: author` 與 verify 修正仍交回原作者。換同一 CLI 帳號的模型不視為額度問題的解法。

## Token 用量與相容性

`costs.jsonl` 每次呼叫新增可選的 `model`、`strength`、`targetStrength` 與 `usageReported`；舊紀錄仍可讀。runner 必須區分「adapter 回報 0 token」與「沒有回報 usage」。`status` 顯示各模型、各 LLM 步驟的輸入、輸出與合計 token；未回報時顯示「未回報」，不當作 0。這些資料用來檢查是否真的減少總 token 與高強度模型使用量。

`FlowRun` 新狀態欄位設為 optional，舊 `state.json` 視為 `balanced`。不啟用 `adaptive` 時，角色分配與 CLI 模型維持既有行為，終端機新增實際模型提示。新模式在建立 worktree 前驗證清單、強度、階段鍵與 `command` 占位符，錯誤用繁體中文指出設定位置。

## 驗證與文件

- 測試設定 schema 的合法／非法模型清單、強度、階段鍵與舊格式；測試 `command` adapter 的 `{model}` 替換。
- 測試純選模函式的階段底線、task 難度、同強度排序、強度不足、重試升級與重現性。
- 測試 engine 串接：角色不變、代打重新選模、審查額度暫停、舊 run resume、終端機模型輸出與用量統計。
- 測試計畫 prompt 和任務格式；原有 adapter 事件解析保持。
- 同一個實作 commit 更新 `README.md` 的使用範例和 `docs/reference.md` 的完整設定、路由規則與 token 統計。執行 typecheck、test、build。
