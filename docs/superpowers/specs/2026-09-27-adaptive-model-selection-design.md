# 依階段與任務難度自動選模

## 目的與已確認的選擇

使用者先登記每個 agent 可用的模型及強度，並自行選擇是否啟用自動選模。每次呼叫 LLM 前，agentflowctl 依流程步驟、task 難度與重試次數，從**已分配角色的 agent** 可用模型中挑選最適合的一個。既有測試、實作、審查、仲裁與修正的分工規則優先。計畫 agent 在 `tasks.json` 標註 task 難度；階段強度有預設且可覆蓋。每次 LLM 步驟的終端機進度輸出須顯示送給 CLI 的模型名稱，若 CLI 回報實際模型 ID 也一併顯示。

目標是減少高強度模型的使用及實際 token 總數。選模不額外呼叫 LLM 判斷難度，失敗重試時升級強度，並記錄實際用量供比較。模型路由本身不能保證每次 run 的 token 總數必然下降：低強度模型可能多重試幾次，反而用掉更多 token。

## 方案選擇

採用「每個 agent 有模型清單」：`cycle` 與 `roles.ts` 先決定負責的 agent，再由規則式選模器決定該 agent 本次使用的模型。這讓 verify 修正仍能交回作者，審查者仍是另一位 agent。沒有採用「每個模型當獨立 agent」方案，因為它需要重寫跨別名的作者與審查者判斷；也沒有採用每步另請 LLM 判斷難度的方案，因為它會增加 token 與失敗點。

## 設定與 CLI

模型強度設定在 `flow.config.json` 的 `agents.<名稱>.models`，每筆填 `name`、`strength`。`name` 可填目標 CLI 接受的模型別名或完整 ID，但必須以目前帳號成功執行最短請求；不能填「輕量模型」等自行命名的顯示文字。模型名稱由 `model add` 驗證通過後寫入設定，文件不硬編一份可能過期或與使用者帳號不符的名單。強度只有 `low`、`medium`、`high`；清單順序是同強度模型的優先順序。`modelSelection.stageStrength` 可逐步驟覆蓋強度預設。

`modelSelection.mode` 為 `balanced` 或 `adaptive`，預設 `balanced`。`run --model-mode balanced|adaptive` 可覆蓋這次 run，選定的 mode 存入 `state.json`，resume 沿用。`adaptive` 啟動前要求本次 `cycle` 的每個 agent 至少登記一個模型，且同一 agent 的模型名稱不重複。`agent add`／`agent set` 原有 `--model` 行為不變。

兩種模式各自只看一組欄位，不互相當後備：

| mode | 使用的欄位 | 忽略的欄位 |
| --- | --- | --- |
| `balanced` | `agents.<name>.model`，沒有時用 `defaultModels.<adapter>`，都沒有時交給 CLI 預設 | `models`、`stageStrength` |
| `adaptive` | `agents.<name>.models` 與 `stageStrength` | `model`、`defaultModels` |

舊的 `model` 與 `defaultModels` 在 `balanced` 模式繼續生效，不需遷移。`adaptive` 模式下，若 claude／codex／gemini agent 的 `extraArgs` 已含 `--model`、`-m` 或 `--model=…`，會與選模器送出的模型參數衝突，啟動前報設定錯誤。

使用者應透過指令管理模型與強度；CLI 會先讀取並驗證整份設定，再寫入 `flow.config.json`：

```bash
agentflowctl model add claude <目前可用的別名或完整ID> --strength medium
agentflowctl model set claude <已登記的名稱> --strength high
agentflowctl model remove claude <已登記的名稱>
agentflowctl model list claude
agentflowctl model check claude
agentflowctl model mode adaptive
agentflowctl model stage taskReview high
```

`model list` 不帶 agent 時列出全部已設定模型；`model check` 不帶 agent 時重驗全部。`model mode` 與 `model stage` 不帶值時顯示現有設定。`model add` 只在可用性檢查成功後寫入，失敗不留下半套設定。`model set` 只改強度，不重驗模型；需重新確認時執行 `model check`。手動編輯 JSON 仍可被 schema 解析，但不會因此自動完成真實可用性檢查；CLI 清單只代表設定內容，不代表模型已驗證。可用性檢查結果只印在終端機，不寫進可由不同帳號共用的 `flow.config.json`。

`model remove` 移除某 agent 的最後一個模型、或 `model mode adaptive` 切換模式時，指令會檢查「受影響的 agent」是否都還有模型，沒有就拒絕並列出缺模型的 agent。有設定 `cycle` 時，受影響的 agent 就是 `cycle`；沒設定時，改看 `agents` 裡的全部 agent。設定指令不偵測 CLI 是否已安裝，只做這個保守檢查；run 啟動時再依 `resolveCycle` 實際挑出的名單做一次完整驗證。

### `command` adapter 的 `{model}`

`command` 參數陣列可使用 `{model}` 占位符，原有 `{prompt}`／stdin 行為保持：

- `adaptive`：`command` 必須含 `{model}`，執行時代入所選模型；缺少占位符就報設定錯誤。
- `balanced`：`command` 含 `{model}` 時代入該 agent 的 `model`（`command` adapter 沒有 `defaultModels`）；沒設定 `model` 就報設定錯誤，不把字面上的 `{model}` 送出去。不含 `{model}` 時維持現狀，`model` 欄位不影響指令。

`command` adapter 要加入 `adaptive`，另須設定 `agents.<名稱>.modelProbe` 命令陣列，透過可重複的 `agent set <名稱> --model-probe-arg=<參數>` 設定；第一個值是執行檔，其餘值是參數，與現有 `--extra-arg` 的輸入方式一致。命令陣列必須含 `{model}`，並由使用者提供的命令實際向底層服務呼叫該模型；成功時輸出單一 JSON 物件 `{ "requestedModel": "輸入名稱", "resolvedModel": "實際模型 ID" }`。兩個欄位都必須是非空字串，`requestedModel` 必須與輸入名稱相同；exit code 0 與任意非空 stdout 不足以通過。`modelProbe` 是使用者自訂程式的驗證契約，agentflowctl 只能驗證回傳格式與名稱一致，無法獨立證明自訂程式真的呼叫了底層模型，因此終端機與文件須明示「由自訂探測命令回報」。沒有 `modelProbe` 時拒絕對 `command` agent 執行 `model add` 或啟用 `adaptive`。

### 模型可用性檢查

`model add` 用目標 agent 的 CLI 與當前登入身分，指定待新增的別名或完整 ID，送出一個最短、無工具的測試請求。只有 `--version` 成功或模型名稱出現在公開清單都不算「目前可呼叫」。

Claude、Codex、Gemini 的檢查新增專用 `invokeModelProbe`，只共用一般執行器的程序管理與 adapter 的 `parse`；不得直接呼叫一般 `invoke`。探測命令使用固定、無工具權限的參數與明確模型名稱，不傳入 agent 的 `extraArgs`，也不沿用一般執行的 `acceptEdits`、`workspace-write` 或 `yolo` 權限。若某 CLI 無法保證工具停用，就不得用它的回覆通過 `model add`，須顯示「無法安全驗證」。`cwd`、`runDir`、`projectRoot` 都指向同一個新建暫存目錄，結束後刪除；暫存目錄只隔離專案檔案，不代替權限限制。`command` adapter 另走上述 `modelProbe` 契約。同時符合下列條件才算成功：

1. 在逾時上限內結束，且結束碼為 0；
2. `parse` 解析出的 `done` 事件為 `ok`，或該 adapter 本來就不發 `done` 事件；
3. 至少有一個內容非空的 `text` 事件（`command` adapter 則須有符合 `modelProbe` 契約的 JSON）。

若 CLI 回報實際使用的完整模型 ID，檢查結果同時顯示「輸入名稱 → 實際模型」；沒有回報時只聲稱輸入名稱可呼叫，不推測其解析結果。網路、認證、額度、模型名稱錯誤與逾時分別顯示可理解的原因。失敗時不寫設定。測試請求可能耗用少量 token，指令執行前與結果中明示。

`model check` 以相同方式重新檢查已登記模型，顯示每一個模型的成功、失敗或無法確認狀態與檢查時間；它不自動刪除失敗模型，也不默默換模型。檢查是當下帳號與 CLI 的結果，不能保證未來額度、權限或模型供應不變。若執行 run 時模型失效，仍依正常 agent 錯誤或額度處理流程回報，不能把過期的檢查結果當成執行保證。

Claude、Codex、Gemini adapter 的檢查都透過已安裝 CLI 的非互動模式與明確模型參數進行，強制停用工具、限制輸出與時間。每個 CLI 的專用探測參數需以該 CLI 的實際行為確認；若 CLI 版本不支援安全的無工具探測，就回報無法安全驗證，不降級成一般 `invoke`。`command` 的結果以自訂探測命令回報的模型為準，不能寫成 agentflowctl 已獨立驗證底層服務。

### 實際模型 ID 的來源

`AgentEvent` 新增 `{ kind: "model"; id: string }`。adapter 只在該 CLI 的事件本身帶有模型 ID 時才發出這個事件，不從名稱推測。依 AGENTS.md，每個會發出這個事件的 adapter，都要在 `agents/adapters.test.ts` 用該 CLI 實際輸出的 JSON 行補測試；沒有實際樣本證明的 adapter 就不發。

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

`verify`、任務驗證、`pr` 沒有 LLM 呼叫，不提供模型設定。

計畫 prompt 要求每個 task 新增 `complexity: "low" | "medium" | "high"`，依影響範圍與技術不確定性標註；計畫審查與計畫修正要檢查並保留它。schema 與驗證的分工如下：

- `TaskItem.complexity` 設為 optional，不設預設值，否則解析後就分不出「有寫」與「被補上」。
- `validatePlan` 依 run 的 mode 另外檢查：`adaptive` run 的每個 task 都必須有合法的 `complexity`，缺少時計畫驗證失敗並重試；`balanced` run 不要求。
- `acceptPlan` 寫出的 `tasks.ordered.json` 保留 `complexity`。
- 「缺少難度視為 `medium`」只在選模函式內處理，確保舊 run 可以 resume；不寫回任何檔案。

難度只供選模，不取代檔案、diff、測試與審查 JSON 等機械關卡。

與 task 有關的寫測試、實作、任務審查、任務修正，基準強度是 `max(階段強度, task.complexity)`；其他 LLM 步驟的基準強度就是階段強度。因此對 task 步驟而言，`stageStrength` 是**底線**，只能把強度往上調，不能把高難度 task 壓到較低強度。

## 呼叫前選模與失敗處理

1. `roles.ts` 先依 `cycle`、seed、作者／審查者排除規則分配 agent。模型強度不改變 `tddSplit`、審查 quorum、`fixStrategy` 或仲裁小組。
2. 目標強度 = 基準強度往上升「升級級數」級，最多到 `high`。每一步的升級級數依下一節的對照表，從 `attempts` 算出。
3. 在該 agent 的清單中選「強度足夠且最低」的模型；同強度依清單順序。若沒有足夠強度，選最強的已登記模型，在終端機提示強度不足。
4. `agentStep()` 把選中的名稱交給 adapter，終端機每次顯示 `agent`、所用模型名稱與是否低於目標；若是別名且 CLI 回報實際模型 ID，完成時再顯示解析結果。log 檔頭與用量紀錄保存送給 CLI 的名稱，實際回報的 ID 另存。CLI 未回報時不宣稱知道別名解析出的 ID。預設安靜模式仍要印模型提示，`-v` 照舊額外印文字與工具呼叫。`balanced` 也顯示本次的 `model`／`defaultModels`；兩者都沒設定時顯示「CLI 預設（名稱未知）」。

選模是純函式，輸入為 run 狀態（mode、`attempts`、`taskIndex`、`fixSource`）、task 難度與當下讀到的設定。mode 存在 `state.json`，resume 時不變；`models` 與 `stageStrength` 則和其他設定一樣每次重新讀取，改了就從下一次 LLM 呼叫開始生效。所以「resume 時選到相同模型」只在設定沒改時成立。

### 升級級數對照表

`attempts` 裡混著兩種計數：一種是步驟**自己執行失敗**（agent 失敗、輸出格式錯誤、交接不合格、測試沒過等），另一種是**審查或驗證未通過的輪數**。升級只能依據前者，以及「修正後仍未通過」的輪數；審查輪數本身不能讓審查升級，否則審查會因為要求修改而一輪比一輪強。計畫與整體審查是多人小組，現有 `plan-review-run`／`review-run` 是整組共用的失敗次數，只繼續用於 `maxAttempts`，不能直接決定每位審查者的模型強度。

寫入與審查步驟直接看自己的失敗次數：

| 設定鍵 | engine 步驟 | 升級級數 |
| --- | --- | --- |
| `spec` | `spec` | `attempts["spec"]` |
| `plan` | `plan` | `attempts["plan"]` |
| `planReview` | `plan-review` | `modelRetryAttempts["plan-review:<reviewer>"]` |
| `planArbiter` | `plan-arbiter` | 0（仲裁失敗時 run 直接暫停，不重試） |
| `taskTests` | `${task}-tests` | `attempts["${task}:tests"]` |
| `taskCode` | `${task}-code` | `attempts["${task}:code"]` |
| `taskReview` | `${task}-review` | `attempts["${task}:review-run"]` |
| `review` | `review` | `modelRetryAttempts["review:<reviewer>"]` |

`FlowRun.modelRetryAttempts` 是可選的整數 map；舊 run 沒有時視為空。計畫或整體審查小組中，僅失敗的審查者增加自己的選模失敗次數；審查者成功產出有效審查時立即清掉自己的計數。小組因後一位失敗而重跑時，前一位仍從基準強度選模；失敗的那位才升級。當整組完成有效審查（核准或要求修改）時清除該組所有 `modelRetryAttempts`。額度暫停不計失敗，也不升級。共用的 `attempts["plan-review-run"]`／`attempts["review-run"]` 仍照現有 `retry()` 累加並控制整組最多重試次數，避免改變既有失敗上限。

修正步驟本身幾乎都會成功（能 commit 就算完成），真正反映「修了還沒好」的是之後的審查或驗證又沒過。所以修正步驟的升級級數 = 自己的失敗次數 + max(未通過輪數 − 1, 0)。減 1 是因為第一次修正本來就是由一輪未通過觸發的，應從基準強度開始：

| 設定鍵 | engine 步驟 | 自己的失敗次數 | 未通過輪數 |
| --- | --- | --- | --- |
| `planFix` | `plan-fix` | `attempts["plan-fix"]` | `attempts["plan-review"]` + `attempts["plan-handoff"]` |
| `taskFix` | `${task}-fix` | `attempts["${task}:fix"]` | `attempts["${task}:review"]` + `attempts["${task}:verify"]` |
| `fix` | `fix` | `attempts["fix"]` | `attempts["verify"]` + `attempts["review"]` |

以任務修正為例：任務審查要求修改（`${task}:review` = 1）時，第一次修正用基準強度；修正後又被審查退回（= 2）時升一級。審查通過後 `${task}:review` 會被清掉，之後任務驗證失敗（`${task}:verify` = 1）時，修正又從基準強度開始。仲裁要求修訂時 engine 會刪掉 `plan-review`，之後的計畫修正同樣回到基準強度。

`maxAttempts` 預設 3，所以同一個 key 最多出現升級 0、1、2 級：`low` 的步驟在第三次嘗試時會升到 `high`。

### 需要一併修正的 `attempts` 清除時機

對照表要成立，下列 key 必須在對應步驟成功時清掉。現在的 engine 沒有清，而這也會讓 `maxAttempts` 跨輪累計，run 比預期更早失敗：

- 整體修正（`fixStage`）成功後只呼叫 `to(run, "verify")`，沒有清掉 `attempts["fix"]`。只要失敗過一次，之後每次整體修正都會停在較高強度。改為成功時清除，行為與任務修正的 `${task}:fix` 一致。
- 計畫審查與整體審查在整個審查小組都完成有效審查（不論核准或要求修改）後，沒有清掉 `plan-review-run`、`review-run`。改為清除，與任務審查的 `${task}:review-run` 一致。

這些是使用者看得到的重試次數變化，要在同一個 commit 更新 `README.md`。

### 額度不足

額度不足沿用現行政策：審查暫停，寫入呼叫先還原半成品再換另一位有額度的 agent；代打 agent 從自己的清單重新選模。`fixStrategy: author` 與 verify 修正仍交回原作者。

換同一 CLI 帳號的模型不視為額度問題的解法。這是刻意的取捨：有些額度是依模型分開計算的（例如高階模型另有週限額），在這種情況下，某個審查步驟的高強度模型額度用完、同帳號的低強度模型其實還能用，run 仍會暫停。改成降級續跑會讓審查強度在使用者不知情下變弱，而且 `QUOTA_PATTERNS` 目前分不出是整個帳號還是單一模型的額度，因此不做。

## Token 用量與相容性

`costs.jsonl` 每次呼叫新增可選的 `model`（送給 CLI 的別名或完整 ID）、`resolvedModel`（CLI 若回報）、`strength`、`targetStrength` 與 `usageReported`；舊紀錄仍可讀。舊紀錄沒有 `usageReported` 時無法判定其中的 0 是實際回報還是 runner 補上的值，標為「回報狀態不明」；保留原始數字供查閱，但不把它當作已驗證的 0，也不納入新制的用量占比。缺少 token 欄位同樣標為未知。

區分「adapter 回報 0 token」與「沒有回報 usage」要改兩處：

- `runner.ts` 目前用 `?? 0` 累加 usage 事件。改為記錄是否收到過 usage 事件，`AgentResult` 新增 `usageReported`，一次都沒收到時 token 欄位不寫數字。
- `store.ts` 的 `usageByAgent` 目前也用 `?? 0` 加總。改為分開統計有回報的 token 與未回報的呼叫次數。

`status` 顯示各模型、各 LLM 步驟的輸入、輸出與合計 token；新紀錄沒有回報時顯示「未回報」，舊紀錄無法判定時顯示「回報狀態不明」，都不當作 0。用量占比只以 `usageReported: true` 的新紀錄計算，並同時顯示未回報與舊紀錄的呼叫次數，讓統計覆蓋範圍可見。不同模型的 token 單價與額度權重不同，直接比 token 總數意義有限，所以 `status` 以**各強度的 token 占比**與高強度呼叫次數為主要比較指標，合計 token 為輔。

`FlowRun` 新狀態欄位設為 optional，舊 `state.json` 視為 `balanced`。不啟用 `adaptive` 時，角色分配與 CLI 模型維持既有行為，終端機新增實際模型提示。新模式在建立 worktree 前驗證清單、強度、階段鍵、`extraArgs` 衝突，以及 `command` 的占位符與 `modelProbe` 設定，錯誤用繁體中文指出設定位置。

## 實作分期

範圍較大，在同一個功能 PR 內分兩個可獨立審查的實作批次；兩批都完成並通過驗證後才交付或合併。使用者第一次能啟用 `adaptive` 時，就必須已有指令可設定強度並驗證模型可用性。

1. **選模核心**：schema（`models`、`modelSelection`、`TaskItem.complexity`、`FlowRun` 新欄位）、`command` 的 `{model}`、選模純函式與升級對照表、審查者個別升級計數、`attempts` 清除時機修正、engine 串接、終端機模型提示、`AgentEvent` 的 `model` 事件、用量欄位與 `status` 統計。此批次尚不開放 `adaptive` 模式供使用者執行。
2. **模型管理與啟用**：`model add`／`set`／`remove`／`list`／`check`／`mode`／`stage`、`command` 的 `modelProbe` 設定指令，以及三家 CLI 的專用無工具探測。指令與驗證完成後才開放 `run --model-mode adaptive` 與 `model mode adaptive`。以假 CLI 測試逾時與各種失敗分類，不在自動測試中呼叫付費模型。

## 驗證與文件

- 測試設定 schema 的合法／非法模型清單、強度、階段鍵與舊格式；測試 `adaptive` 下 `extraArgs` 含模型參數時報錯。
- 測試 `command` adapter 的 `{model}` 替換：`adaptive` 缺占位符或 `modelProbe` 報錯、`balanced` 有占位符但沒設 `model` 報錯、`balanced` 沒有占位符時行為不變；探測輸出不符契約或回報名稱不同時，`model add` 拒絕寫入。
- 測試 `TaskItem.complexity`：`adaptive` 缺少時計畫驗證失敗、`balanced` 不要求、`tasks.ordered.json` 保留欄位、選模時缺少視為 `medium`。
- 測試純選模函式的階段底線、task 難度、同強度排序、強度不足、重現性，以及升級對照表的每一列：審查要求修改不讓審查升級、小組後一位失敗時只讓該審查者升級、修正後仍未通過才讓修正升級、未通過輪數被清掉後回到基準強度。
- 測試 `attempts` 清除時機：整體修正成功後清除 `fix`，審查小組完成有效審查後清除 `plan-review-run`、`review-run`。
- 測試 engine 串接：角色不變、代打重新選模、審查額度暫停、舊 run resume、終端機模型輸出與用量統計。
- 測試 runner 與 `usageByAgent` 區分「回報 0」、「未回報」與舊紀錄的「回報狀態不明」；用量占比排除後兩者並顯示統計覆蓋範圍。
- 以實際 JSON 行測試會發出 `model` 事件的 adapter；原有 adapter 事件解析保持。
- 第二批次：測試 `model add`／`set`／`remove`／`list`／`check`／`mode`／`stage` 的設定變更、完整驗證與失敗不寫入；`remove` 與 `mode adaptive` 在有無 `cycle` 時的檢查範圍；以可控制的假 CLI 測試成功判定的三個條件、拒絕、逾時、暫存目錄隔離、探測參數不含工具權限且不傳 `extraArgs`。測試無法安全停用工具時拒絕驗證，不在自動測試中呼叫付費模型。
- 每個階段的實作 commit 都同步更新 `README.md` 的使用範例和 `docs/reference.md` 的完整設定、路由規則、升級對照表與 token 統計。執行 typecheck、test、build。

## CLI 能力依據

Claude Code 的官方 [CLI 參考](https://code.claude.com/docs/en/cli-reference)列出 `--model` 與非互動 `-p`；Gemini CLI 的官方[參考文件](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md)列出 `--model` 與 `--prompt`。本機 `codex exec --help` 列出 `--model`、`--json`、`--sandbox`、`--ephemeral`。這些參數只證明可以嘗試指定模型，可用性仍須以該帳號的實際請求確認。
