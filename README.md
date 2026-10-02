# agentflowctl

[![npm version](https://img.shields.io/npm/v/agentflowctl.svg)](https://www.npmjs.com/package/agentflowctl)

讓 Claude Code、Codex、Gemini CLI 等 agent 在同一個專案裡分工：整理需求、規劃、寫測試與程式、交叉審查，最後建立 PR。agentflowctl 負責推進流程，並用檔案、測試和檢查結果決定能否進到下一步。

目前內建支援三種 LLM CLI：**Claude Code、Codex、Gemini CLI**。未來可擴充自定義 LLM adapter，讓其他模型供應商加入流程。目前若要串接其他 CLI，可使用 `command` adapter，自行提供執行命令；需要模型驗證時，也須提供探測命令。

每次執行都會建立獨立的 git worktree 與 `flow/<id>` 分支，不會直接修改你目前的工作目錄。兩個 agent 就能運作；若只有一個，也能執行，但無法做到跨 agent 審查。

## 開始使用

需要 **Node.js 22 以上**、git，以及至少一個已安裝且完成登入的 agent CLI。建議先準備兩個，例如 Claude Code 與 Codex。

在要開發的專案根目錄執行：

```bash
npx agentflowctl config agent setup
npx agentflowctl config doctor
npx agentflowctl run --req "登入表單加入驗證與錯誤訊息"
```

`config agent setup` 會找出本機可用的 Claude Code、Codex、Gemini CLI，讓你選擇要加入哪些 agent，接著選模型模式（預設 `balanced`），最後寫入專案根目錄的 `flow.config.json`。`config doctor` 會檢查設定與 CLI 是否可執行。agentflowctl 沒有預設 agent，因此第一次使用要先完成設定。

若要使用現成的需求文件，改用：

```bash
npx agentflowctl run --req-file ./requirement.md
```

下文以 `agentflowctl` 為例；未全域安裝時，在指令前加 `npx`。想全域安裝可執行 `npm install -g agentflowctl`。

## 執行時會發生什麼

1. agent 整理需求與驗收條件，接著寫計畫，交給其他 agent 審查。
   驗收條件的原則（規格、計畫審查與修訂都依同一套標準）：
   - 行為變更：把需要新寫或修改程式才成立的獨立行為列為驗收條件；不同輸入或情境需要不同結果時，以及新行為所需的邊界情況與錯誤處理，都分開列。
   - 不另立條件：相同結果的不同說法、修正後自然成立的推論，以及沒有具體誤傷風險的既有行為，不會各自變成驗收條件和實作任務；審查者與修訂者會保留必要條件，並合併或刪除重複的。
   - 不回歸條件：需求明寫要維持不變的行為各列一條，其餘限於最關鍵的一兩條。
   - 非行為變更：需求本身若是文件、設定、純重構或特徵化測試，仍以所需產物與自動檢查結果列出驗收條件。
2. 依計畫逐個任務寫出會失敗的測試，再由另一位 agent 實作到測試通過；每個任務都會經過審查與驗證。沒有相依關係的任務會同時在各自的 worktree 裡執行，完成後依序合併回分支（見「平行執行任務」）。計畫 agent 會依改動內容在任務標記 `tdd`：建置流程、設定、文件、型別、純重構，以及實作前就會通過的特徵化測試，會略過紅綠燈直接實作，改由任務審查與驗證把關。描述寫明不要求紅燈卻沒標 `tdd: false` 的計畫不會通過。已定案的計畫若仍帶著這個衝突，執行到該任務時仍會寫測試，但測試一開始就通過也算完成，不會再要求紅燈、也不會因此讓 run 失敗。紅燈測試被退回一次、原因是測試一開始就通過（行為早已存在，例如前一個任務順手做掉了）時，下一次嘗試同樣改為接受這份特徵化測試，不再重試到上限；仍由任務審查與驗證把關。測試階段若完全沒有新增或修改任何檔案、但現有測試已通過，也視為這個任務的行為已被既有測試涵蓋，直接進入實作，不會以「未寫測試」重試。綠燈實作若讓不了測試通過（實作者沒有任何變更，同一個任務連續兩次失敗，或第一次失敗就是測試檔呼叫了「由套件匯入、但已安裝版本沒有」的函式，例如舊版 @testing-library/react 的 `renderHook is not a function`），多半是測試本身寫錯（例如用了專案沒有的 API），再叫實作者重試只會原地打轉：這時會丟掉這一輪的測試與實作，退回測試階段重寫（重試分類 `tests_invalid`），回饋會附上測試輸出與舊測試 commit 的 hash；同一個任務最多退回 2 次，退回達上限仍過不了時，run 會暫停（`status` 顯示原因），等你檢查測試依賴與 `.flow/feedback.md` 後 `resume`，`resume` 會從測試階段重來並再給 2 次退回機會。另外，測試提交後、叫實作者之前，會先檢查測試檔以函式呼叫的套件匯出（例如 `renderHook`）在已安裝版本裡是否存在，不存在就直接以 `tests_invalid` 退回測試作者，不必等到綠燈失敗；套件載入不了時一律略過，不誤判。任務的實作與修正若動到「只有後面任務描述提到」的檔案（以描述中寫出的 `目錄/檔名.副檔名` 路徑比對），這次變更會被還原並要求重做，retry 分類為「動到後面任務的檔案」；這個檢查只擋前兩次嘗試，避免路徑比對誤判讓 run 卡死，之後仍由審查把關。專案沒有測試框架時，所有任務都略過紅綠燈，也不跑 `test` 檢查。只跑檢查、不改檔案的工作不要拆成實作任務；這種任務若沒有檔案變更會直接略過，不再要求 commit。需要人眼確認的任務標成 `kind: confirm`，計畫定案時，這些任務、只由它們負責的驗收條件，以及 `plan.md` 裡對應的 `## T-n` 段落，會從 `.flow/` 的 `tasks.json`、`acceptance.json`、`plan.md` 搬到 run 目錄（`.agentflowctl/runs/<id>/confirmations.json` 與 `confirmation-details.json`）：實作、任務審查、程式碼審查與修正都看不到它們，不會因此重試或停下來，只在開 PR 時以未勾選的「需要人工確認」清單附在描述最前面，由你在合併前親自確認（`spec.md` 不會被改寫）。`status` 在任務清單之外另列「待你確認（不進實作）」；`confirmations <id>` 只印這個區塊。計畫還沒通過首次驗證前查詢，清單會從尚未經檢查的草稿蒐集，標題會多帶「（計畫尚未定案，以下為草稿）」，項目最終可能不會定案。計畫與計畫審查也會核對實作階段的硬性限制：`tdd: true` 任務的綠燈實作不可改測試檔（例外：連同被測檔一起刪除的測試檔，例如移除舊 helper 時，會放行）、修正階段不可刪測試檔，所以要改寫既有測試檔、或只刪測試檔的任務必須標 `tdd: false`，否則會被要求修改。
3. 全部任務完成後，再執行專案檢查與整體程式碼審查。未通過的項目會交回修正。
4. 有 `origin` 時會推送分支；若 `gh` 可用，會嘗試建立 PR，描述裡會附上 `kind: confirm` 的待人工確認清單。沒有 `origin` 時，完成的分支留在本機。

流程預設會自動往下走。想在計畫通過審查後親自確認，可加 `--manual-plan`；確認後執行 `agentflowctl approve <id>`。

**計畫有疑慮時不必整份重寫。** 兩種方式可以並用：

- **補充意見**：`agentflowctl replan <id> --note "T-2 要改用既有的 helper"`（長的意見用 `--note-file <路徑>`）。意見會以「人工補充意見」交給計畫修訂者，只改相關的任務與段落，其餘原樣保留，比重跑計畫省 token。
- **手改計畫檔**：直接編輯 `.agentflowctl/worktrees/<id>/.flow/` 的 `spec.md`、`acceptance.json`、`plan.md`、`tasks.json`，再執行 `agentflowctl replan <id>`。程式會重新檢查格式、驗收條件對應與任務相依；沒通過就印出原因、不改 run，修好再執行一次即可。

改完預設回到計畫審查（分層審查只重審有變動的群；內容沒變的審查結果直接沿用）。加 `--no-review` 則不再送審：補充意見改完直接定案，手改的只做格式檢查，不呼叫任何 agent。完成後回到 `awaiting_approval`，確認後照常 `approve`。`replan` 適用於等待核准，以及停在計畫階段（暫停或失敗）的 run。

需要先取用某個階段的產出時，可用 `--stop-after <階段>`。可選停點是 `spec`（規格）、`plan`（計畫審查完成）、`implement`（所有任務完成）、`verify`（測試與 checks 通過）、`review`（程式碼審查完成）或 `pr`（PR 流程完成）。除了 `pr` 會照常結束外，其他停點完成後會進入 `paused`，可檢視 worktree 與 `.flow/` 檔案，再執行 `agentflowctl resume <id>` 從下一階段接續；`--manual-plan` 與 `--stop-after` 不能同時使用。

agentflowctl 會依專案的 `packageManager`、lockfile 與 `package.json` scripts 選擇安裝、測試及檢查指令。偵測到的 `lint` 與 `typecheck`（`type-check`）檢查只在最後整支分支的驗證才跑，每個任務的驗證不跑；`lint` 只檢查整支分支相對基底分支改過的程式檔（排除 `.flow/`，沒有可檢查的檔案就略過；一律沿用專案原本的 lint 設定，agentflowctl 不會修改任何 eslint 設定檔，只在指令列略過自己產生的 `.flow/`、`.agentflowctl/`），型別檢查仍是整個專案（`tsc` 無法只檢查部分檔案）。`package.json` 沒有對應 script 時直接略過，不會退回 `npx eslint .` 或 `npx tsc --noEmit`；要沿用舊行為，請在 `flow.config.json` 自行寫 `checks`。同一次驗證裡，install 先跑完，其餘檢查預設同時執行（`checksConcurrency` 可限制同時數量，`1` 為一次一個）；結果與 log 仍照設定順序列出。第一次執行時，請留意終端機印出的偵測結果；需要調整可在 `flow.config.json` 指定 `install`、`test` 或 `checks`。`package.json` 的依賴或 `test` script 看不出測試框架（且沒有手動設定 `test`）時，終端機會提示「未偵測到測試框架」，並略過紅綠燈；要改回來，在 `flow.config.json` 設定 `test`。

## 查看進度

`run` 開始時會印出 run id，例如 `f-xxxx`。執行中預設只顯示階段進度；加 `-v`（或在 `flow.config.json` 設 `"verbose": true`）可看到 agent 文字、工具呼叫與專案指令。

```bash
agentflowctl list                  # 列出 run
agentflowctl status f-xxxx         # 看進度、結果與下一步（任務與待人確認分區）
agentflowctl confirmations f-xxxx  # 只列出需要人眼確認的任務
agentflowctl logs f-xxxx           # 列出各步驟的 log
agentflowctl logs f-xxxx --latest  # 看最新一份 log
agentflowctl stats f-xxxx          # 各步驟耗時、執行與失敗次數
agentflowctl insights              # 這個專案所有 run 的結果、失敗原因、用量、步驟失敗、重試原因與改善建議
agentflowctl resume f-xxxx         # 從暫停、中斷或失敗處接續
```

`status` 會列出目前階段、未結的交接事項與下一步指令；失敗或暫停時也會顯示原因。任務進度與「待你確認（不進實作）」分成兩個區塊：實作任務在「任務」，`kind: confirm` 的項目在「待你確認（不進實作）」，兩邊都會列出。計畫還沒通過首次驗證時，這個區塊的標題會多帶「（計畫尚未定案，以下為草稿）」，代表清單是從尚未經檢查的草稿蒐集，項目最終可能不會定案。只想看要人眼確認的項目時，用 `confirmations <id>`。要看某一步的詳細輸出，可用 `logs <id> <編號>`；加 `--full` 看完整工具內容，或加 `--raw` 看原始輸出。

`stats` 依 log 的開始與結束時間統計每個步驟的執行次數、失敗次數、總耗時與最長一次，並分開列出 agent 與專案指令（install、測試、checks）各占多少時間，最耗時的步驟排在最前面。沒有結束紀錄的 log 列為未完成，不計入耗時；總經過時間包含暫停與等待核准。紅燈階段的測試指令（`T-<n>-red`）失敗是預期結果，只有測試意外通過才計為失敗。

`insights` 把所有 run 分成獨立區塊彙總：最終狀態、失敗原因（重試達上限、仲裁停止、agent 次數用完等）、用量（輸入／輸出／cache、強度占比、階段／agent，各 run 用量最高的任務）、各模型與步驟、步驟執行與失敗（與 `stats` 相同取 log 的檔頭檔尾，跨 run 不計總經過時間）、關卡重試原因。任務關卡與任務步驟不分 task id 合併計算。最後列出最多五則建議，規則由程式套門檻，不是再請 agent 分析。「輸入遠大於輸出」不計入 cache 讀取（Claude 的 cache 寫入仍計入），門檻是非 cache 的輸入與輸出合計至少 5000 tokens 且輸入佔 85% 以上；cache 讀取量另外列在說明中。合計 token 不是主指標。覆蓋不足時會先警告占比可能失真。各分組是同一批呼叫的不同切片，不要跨組相加。舊 run 沒有重試或失敗原因紀錄，不會回填。單一 run 的全量明細仍用 `status <id>` 與 `stats <id>`。

執行紀錄在 `.agentflowctl/runs/<id>/`，工作分支在 `.agentflowctl/worktrees/<id>/`。不再需要某次 run 時，可用 `agentflowctl clean <id>` 清除 worktree 與紀錄；`agentflowctl clean --all` 一次清除所有 done、failed 的 run，以及沒有紀錄的 worktree（進行中、暫停、等待核准的不動）。`flow/<id>` 分支會保留。

## 執行停下來時怎麼做

先執行 `agentflowctl status <id>`，看「階段」與「原因」，再依情況處理：

| 狀況 | 下一步 |
| --- | --- |
| 按 Ctrl-C，或終端機意外關閉 | 執行 `agentflowctl resume <id>`；沒有結束紀錄的步驟會重跑 |
| `awaiting_approval`：計畫等你確認 | 閱讀 `.agentflowctl/worktrees/<id>/.flow/plan.md`，確認後執行 `agentflowctl approve <id>`；有疑慮就補充意見或手改計畫檔後執行 `agentflowctl replan <id>` |
| `paused`：agent 額度用完 | 等額度恢復後執行 `agentflowctl resume <id>`；審查步驟不會換 agent 代審。在仲裁途中暫停時，resume 直接回到仲裁，不重跑計畫審查；暫停期間若改了計畫檔，或在 `flow.config.json` 把 `planArbiter` 關掉，就改成重新審查 |
| `paused`：已完成指定停點 | 依 `status` 顯示的下一階段檢視產出，再執行 `agentflowctl resume <id>` 接續；run 會保留原本的停點設定 |
| `failed`：仲裁連續沒有產生有效裁決 | 仲裁者沒寫出 `.flow/plan-arbiter.json`、格式錯誤或交接無效時不會暫停，會把原因寫進 `.flow/feedback.md` 並自動重跑仲裁（不重跑計畫審查）；無效的檔案移到 `.agentflowctl/runs/<id>/reviews/plan-arbiter-<輪>-<agent>-invalid.json`。連續達重試上限才失敗，查看 log 後執行 `agentflowctl resume <id>` 會再回到仲裁 |
| `failed`：測試、檢查、審查或 agent 執行失敗 | 依 `status` 提示查看失敗的 log，處理原因後執行 `agentflowctl resume <id>`；失敗階段會重試 |
| `failed`：已達 agent 執行次數上限 | 用 `agentflowctl resume <id> --max-agent-runs 100` 調高上限後接續，數字須大於已執行次數 |

交接事項會自動去重：agent 新回報的事項若和帳本裡還沒處理（`open`）的事項種類與目標階段相同，而且摘要完全相同，或指向同一個檔案或驗收條件、文字也夠相似，就不另開新事項，而是併進原事項並累計 `repeats`（給 agent 的交接清單會標「已重複回報 N 次」）。已提議修正、已結案或已接受的事項不會吸收新回報，審查者重新提出就是一筆新事項。

寫作類步驟（規格、計畫、計畫修正、紅燈測試、綠燈實作、fix）完成且通過關卡後，若 `.flow/handoff-response.json` 不合格，會請同一家 agent 再呼叫一次，只補寫交接（不重做工作，也不換人代打）；補寫期間對其他檔案的變更與 commit 一律丟棄（規格與計畫類步驟沒有 commit，補寫者會被告知範圍為空，不會把事項標成已處理，補寫期間對規格與計畫檔的修改同樣丟棄）。補寫仍不合格或額度用完，才照舊還原這一步並重試。補寫呼叫記在原步驟名稱底下，`stats` 與 `logs` 會多一筆，也會計入 `--max-agent-runs` 的次數。

例如失敗時，可照終端機列出的 log 編號查看原因：

```bash
agentflowctl status f-xxxx
agentflowctl logs f-xxxx 7
agentflowctl resume f-xxxx
```

若不打算接續，先用 `agentflowctl cancel <id>` 標記放棄，再用 `agentflowctl clean <id>` 清除 worktree 與執行紀錄。仍在執行中的 run，先在原終端機按 Ctrl-C。`clean` 會保留 `flow/<id>` 分支。

## 參數怎麼設定

設定分成三處：**這次執行的選項**寫在 `run` 或 `resume` 後面；**專案設定**寫在專案根目錄的 `flow.config.json`；**執行環境設定**用環境變數。先用 `config agent setup` 建立 agent 設定，再視需要調整其他欄位。

### 指令分層

指令分三層：**執行**（`run`、`approve`、`replan`、`resume`、`cancel`、`clean`）、**檢視**（`status`、`confirmations`、`list`、`logs`、`stats`、`insights`），以及全部放在 `config` 底下的**設定**：

```
config agent list | add | set | remove | cycle | setup   管理 agent 與參與名單
config agent model add | set | remove | list | check      某個 agent 的模型清單、強度與 effort
config selection mode | stage                             選模策略：模型模式、各階段最低強度
config doctor                                             檢查 CLI 是否可執行與主要設定
```

模型清單屬於個別 agent，所以放在 `config agent model`；模型模式與階段強度是整個專案共用的策略，放在 `config selection`（對應 `flow.config.json` 的 `modelSelection`）。舊的 `agent …`、`model …`、`doctor` 已移除。

### 指令選項

| 指令或選項 | 怎麼設定 |
| --- | --- |
| `run --req "..."` / `--req-file <檔案>` | 二選一，直接輸入需求或讀取檔案 |
| `replan <id> --note <文字>`／`--note-file <路徑>`／`--no-review` | 補充意見或手改計畫檔後重做計畫，見「計畫有疑慮時不必整份重寫」；`--no-review` 改完不再送審 |
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

### Agent 設定

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

### 依階段與任務難度選模型

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

#### 推理強度（effort）

Claude Code 與 Codex 支援指定推理強度，Gemini CLI 與 `command` 不支援（設定了會在載入時報錯）。可設在兩個地方：

- `agents.<名稱>.effort`：該 agent 的預設，`balanced` 模式直接使用；`adaptive` 模式下，模型沒有自己的 effort 時也沿用它。
- `agents.<名稱>.models[].effort`：該模型被選中時使用，優先於 agent 的 `effort`。

```bash
agentflowctl config agent set claude --effort medium
agentflowctl config agent model add claude MODEL_NAME --strength high --effort high
agentflowctl config agent model set claude MODEL_NAME --effort low     # 只改 effort；--effort none 清除
```

Claude Code 以 `--effort <值>` 傳入，Codex 以 `-c model_reasoning_effort="<值>"` 傳入，放在 `extraArgs` 之前。可用的值由各 CLI 決定（例如 Claude Code 的 `low`、`medium`、`high`、`xhigh`、`max`），agentflowctl 只檢查非空，`config agent model add` 與 `config agent model check` 會連同 effort 一起送出探測請求，值不合法時會失敗。`adaptive` 模式下 `extraArgs` 不可再放 `--effort`，Codex 也不可透過 `-c` 或 `--config` 設定 `model_reasoning_effort`（包含參數合併形式），避免覆寫選定的 effort；其他 config 參數仍可使用。終端機每次呼叫會在模型名稱後顯示 `（effort …）`，log 檔頭也會記錄；`config agent list` 與 `config agent model list` 會列出設定的 effort。

#### 模型驗證

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
| `agents.<名稱>.effort` | 無 | 推理強度，只有 `claude` 與 `codex` 支援；`model` 項目的 `effort` 優先 |
| `agents.<名稱>.models` | 無 | 自動選模時使用；每筆有 `name`、`strength`，可加 `effort`，建議用 `config agent model add` 設定並實際驗證 |
| `fixStrategy` | `"ring"` | `"ring"` 由審查者以外的 agent 修正；`"author"` 交回最後作者 |
| `tddSplit` | `true` | 有多位 agent 時，`true` 會把同一任務的測試與實作分給不同 agent |
| `reviewQuorum` | `1` | 任務與最終程式碼審查需要幾位不同審查者核准 |
| `planReviewQuorum` | `1` | 計畫需要幾位不同審查者核准 |
| `taskConcurrency` | 不限 | 沒有相依關係的任務最多幾個同時執行（各在自己的 worktree）；`1` 為一次一個任務，等同關閉平行任務；說明見「平行執行任務」 |
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

#### 平行執行任務

實作階段開始時，若有兩個以上的任務同時可以開始（沒有 `dependsOn`，或依賴的任務都已完成），這些任務會各占一條「車道」同時執行；只有相依鏈（每個任務都依賴前一個）、或 `taskConcurrency` 設為 `1` 時，照舊一次做一個任務。可用 `taskConcurrency` 限制同時數量。

- **每條車道是一個小 run。** 車道有自己的 git worktree（`.agentflowctl/runs/<id>/lanes/<任務>/worktree`）與分支 `flow/<id>+<任務>`，起點是 run 當時的 HEAD，也有自己的 `.flow/` 與 `state.json`。任務在車道裡走和順序執行完全一樣的流程：紅燈、綠燈、任務審查、任務驗證、修正。角色輪替仍依任務在清單中的位置決定，與順序執行時一致。
- **共用的紀錄寫進所屬 run。** log、用量、重試、代打與交接帳本都記在 run 底下，所以 `logs`、`stats`、`insights` 與 `maxAgentRuns` 不需要另外合併。因此車道裡的 agent 也看得到其他車道開的交接事項。
- **合併一次一個。** 車道完成後依完成順序合併回 run 的分支（保留合併 commit，訊息 `merge(T-n): …`），合併後才解鎖依賴它的任務；車道的 worktree 與分支隨即清掉。合併後若 `package.json` 或 lockfile 變了，會在 run 的 worktree 重新安裝。
- **衝突時重做。** 和已合併的任務在同一處衝突時，這條車道會回到最新的分支、從寫測試重做（重試分類 `merge_conflict`，次數計入 `maxAttempts`）。計畫與計畫審查的 prompt 都要求：會修改同一個檔案、或用到另一個任務新增內容的任務必須用 `dependsOn` 排出先後。語意上的衝突（沒有文字衝突但合在一起壞掉）由最後的整體驗證與程式碼審查把關。
- **車道裡不安裝相依套件。** 車道的 `node_modules` 是指向 run 的 symlink，各自安裝會互相覆寫，所以車道裡只跑測試與 build 等檢查；新增相依套件的任務，合併後才會在 run 裡安裝。
- **失敗、暫停與 resume。** 任一車道失敗（重試達上限、agent 次數用完）就不再開新車道，已在跑的跑完並合併，run 以失敗結束，原因會寫明是哪個任務。額度用完同理：額度是 agent 層級的，用同一家 agent 的車道也會一起暫停，其餘車道跑完後 run 暫停。`resume` 時已合併的任務不重做，失敗或暫停的車道接續。
- `maxAgentRuns` 是整個 run 所有車道合計的次數；平行時可能略微超出（最多多出同時執行的車道數）。
- `status` 在任務清單裡標出正在平行執行的任務。

#### 平行審查

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

## 發版（維護者）

在 clone 下來的 repo 裡用 `pnpm release <patch|minor|major|x.y.z> [--dry-run]` 發版，只能在 `main` 執行：

```bash
pnpm release patch --dry-run   # 只檢查與驗證，不建立 Release
pnpm release minor             # 確認後建立 v0.x+1.0 的 GitHub Release
pnpm release 1.0.0             # 指定版本，必須大於目前最新的 tag
```

腳本會先檢查目前在 `main`、工作區乾淨、與 `origin/main` 同步、`gh` 已登入、新 tag 不存在，再跑 typecheck、test、build（通過只顯示 ✓，失敗才印出完整輸出），列出自上個 tag 以來的 commit 並等你輸入 `y` 確認，接著把 `package.json` 的 `version` 更新為新版號、commit 並 push 到 `main`，再用 `gh release create --generate-notes` 建立 Release。npm 由 Release 觸發的 `npm-publish.yml` 發布。

## 更多文件

- [完整指令、設定與流程說明](docs/reference.md)：選項、角色分配、審查規則、log、額度處理與技術細節。
- [各階段讀寫的檔案](docs/engine-stage-files.md)：`.flow/`、回饋與審查檔案如何交接。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
