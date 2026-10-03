# 執行流程細節

操作說明請看 [README](../README.md)。本文件說明一次 run 內部怎麼走，以及各階段的關卡規則。設定欄位見 [設定詳解](configuration.md)。

## 流程

1. agent 整理需求與驗收條件，接著寫計畫，交給其他 agent 審查。
   驗收條件的原則（規格、計畫審查與修訂都依同一套標準）：
   - 行為變更：把需要新寫或修改程式才成立的獨立行為列為驗收條件；不同輸入或情境需要不同結果時，以及新行為所需的邊界情況與錯誤處理，都分開列。
   - 不另立條件：相同結果的不同說法、修正後自然成立的推論，以及沒有具體誤傷風險的既有行為，不會各自變成驗收條件和實作任務；審查者與修訂者會保留必要條件，並合併或刪除重複的。
   - 不回歸條件：需求明寫要維持不變的行為各列一條，其餘限於最關鍵的一兩條。
   - 非行為變更：需求本身若是文件、設定、純重構或特徵化測試，仍以所需產物與自動檢查結果列出驗收條件。
2. 依計畫逐個任務寫出會失敗的測試，再由另一位 agent 實作到測試通過；每個任務都會經過審查與驗證。沒有相依關係的任務會同時在各自的 worktree 裡執行，完成後依序合併回分支（見[設定詳解的「平行執行任務」](configuration.md#平行執行任務)）。計畫 agent 會依改動內容在任務標記 `tdd`：建置流程、設定、文件、型別、純重構，以及實作前就會通過的特徵化測試，會略過紅綠燈直接實作，改由任務審查與驗證把關。描述寫明不要求紅燈卻沒標 `tdd: false` 的計畫不會通過。已定案的計畫若仍帶著這個衝突，執行到該任務時仍會寫測試，但測試一開始就通過也算完成，不會再要求紅燈、也不會因此讓 run 失敗。紅燈測試被退回一次、原因是測試一開始就通過（行為早已存在，例如前一個任務順手做掉了）時，下一次嘗試同樣改為接受這份特徵化測試，不再重試到上限；仍由任務審查與驗證把關。測試階段若完全沒有新增或修改任何檔案、但現有測試已通過，也視為這個任務的行為已被既有測試涵蓋，直接進入實作，不會以「未寫測試」重試。綠燈實作若讓不了測試通過（實作者沒有任何變更，同一個任務連續兩次失敗，或第一次失敗就是測試檔呼叫了「由套件匯入、但已安裝版本沒有」的函式，例如舊版 @testing-library/react 的 `renderHook is not a function`），多半是測試本身寫錯（例如用了專案沒有的 API），再叫實作者重試只會原地打轉：這時會丟掉這一輪的測試與實作，退回測試階段重寫（重試分類 `tests_invalid`），回饋會附上測試輸出與舊測試 commit 的 hash；同一個任務最多退回 2 次，退回達上限仍過不了時，run 會暫停（`status` 顯示原因），等你檢查測試依賴與 `.flow/feedback.md` 後 `resume`，`resume` 會從測試階段重來並再給 2 次退回機會。另外，測試提交後、叫實作者之前，會先檢查測試檔以函式呼叫的套件匯出（例如 `renderHook`）在已安裝版本裡是否存在，不存在就直接以 `tests_invalid` 退回測試作者，不必等到綠燈失敗；套件載入不了時一律略過，不誤判。紅燈階段跑全套測試失敗時，若失敗的是別的測試檔（輸出裡含 `FAIL`／`❯`／`×` 的行只指到不是這個任務新增或修改的測試檔），代表分支上早就壞了（例如平行任務合併後的語意衝突），實作者修不了也不該修：這一輪的測試會還原，run 暫停並列出那些檔案（`status` 顯示原因），修好後 `resume`；輸出認不出失敗檔案時照常進行。綠燈階段跑全套測試失敗、而且失敗的是前面任務的測試檔（不是這個任務自己的）時，不會退回重寫這個任務的測試（那救不了）：第一次以 `tests_not_green` 退回實作者，回饋說明不可改既有測試、必須改變前面任務的行為時要寫 `.flow/amend-request.json`；連續第二次仍如此就暫停（`status` 顯示原因），檢查後 `resume` 再給兩次機會。修補任務（`kind: "amend"`）的測試作者要負責把與新行為衝突的既有測試一併更新，因為接下來的實作者不能改測試檔。每個任務的「審查或驗證未通過 → 修正」合計最多來回 `maxTaskRounds`（預設 3）圈，超過暫停等人。任務的實作與修正若動到「只有後面任務描述提到」的檔案（以描述中寫出的 `目錄/檔名.副檔名` 路徑比對），這次變更會被還原並要求重做，retry 分類為「動到後面任務的檔案」；這個檢查只擋前兩次嘗試，避免路徑比對誤判讓 run 卡死，之後仍由審查把關。專案沒有測試框架時，所有任務都略過紅綠燈，也不跑 `test` 檢查。只跑檢查、不改檔案的工作不要拆成實作任務；這種任務若沒有檔案變更會直接略過，不再要求 commit。需要人眼確認的任務標成 `kind: confirm`，計畫定案時，這些任務、只由它們負責的驗收條件，以及 `plan.md` 裡對應的 `## T-n` 段落，會從 `.flow/` 的 `tasks.json`、`acceptance.json`、`plan.md` 搬到 run 目錄（`.agentflowctl/runs/<id>/confirmations.json` 與 `confirmation-details.json`）：實作、任務審查、程式碼審查與修正都看不到它們，不會因此重試或停下來，只在開 PR 時以未勾選的「需要人工確認」清單附在描述最前面，由你在合併前親自確認（`spec.md` 不會被改寫）。`status` 在任務清單之外另列「待你確認（不進實作）」；`confirmations <id>` 只印這個區塊。計畫還沒通過首次驗證前查詢，清單會從尚未經檢查的草稿蒐集，標題會多帶「（計畫尚未定案，以下為草稿）」，項目最終可能不會定案。計畫與計畫審查也會核對實作階段的硬性限制：`tdd: true` 任務的綠燈實作不可改測試檔（例外：連同被測檔一起刪除的測試檔，例如移除舊 helper 時，會放行）、修正階段不可刪測試檔，所以要改寫既有測試檔、或只刪測試檔的任務必須標 `tdd: false`，否則會被要求修改。
3. 全部任務完成後，再執行專案檢查與整體程式碼審查。未通過的項目會交回修正。
4. 有 `origin` 時會推送分支；若 `gh` 可用，會嘗試建立 PR，描述裡會附上 `kind: confirm` 的待人工確認清單。沒有 `origin` 時，完成的分支留在本機。

流程預設會自動往下走。想在計畫通過審查後親自確認，可加 `--manual-plan`；確認後執行 `agentflowctl approve <id>`。

## 計畫有疑慮時不必整份重寫

- **補充意見**：`agentflowctl replan <id> --note "T-2 要改用既有的 helper"`（長的意見用 `--note-file <路徑>`）。意見會以「人工補充意見」交給計畫修訂者，只改相關的任務與段落，其餘原樣保留，比重跑計畫省 token。
- **手改計畫檔**：直接編輯 `.agentflowctl/worktrees/<id>/.flow/` 的 `spec.md`、`acceptance.json`、`plan.md`、`tasks.json`，再執行 `agentflowctl replan <id>`。程式會重新檢查格式、驗收條件對應與任務相依；沒通過就印出原因、不改 run，修好再執行一次即可。

`kind: confirm` 的人工確認項目在計畫定案時已搬出 `.flow/`；`replan` 會先把它們（任務、專屬驗收條件、計畫段落）併回 `.flow/`，讓你和計畫修訂者看得到、改得動，也能刪掉。再次定案時，確認清單會依當時的計畫檔重建：刪掉的項目從 PR 清單消失，改寫的採用新內容，沒動的保持不變。

改完預設回到計畫審查（分層審查只重審有變動的群；內容沒變的審查結果直接沿用）。加 `--no-review` 則不再送審：補充意見改完直接定案，手改的只做格式檢查，不呼叫任何 agent。完成後回到 `awaiting_approval`，確認後照常 `approve`。`replan` 適用於等待核准，以及停在計畫階段（暫停或失敗）的 run。

## 完成後開第二輪

`agentflowctl iterate <id> --req "補充需求"`（或 `--req-file <路徑>`）適用於 `done` 的 run，在同一個 worktree 與分支上再跑一輪：

- 補充需求附加在原需求後面，狀態回到 `spec`，之後照常走計畫、實作、驗證、審查。第一輪的程式碼都在分支上，agent 以它為基礎修改。
- 上一輪的規格與計畫（`spec.md`、`acceptance.json`、`plan.md`、`tasks.json`）存進 `.flow/round-N/`，讓這一輪的 agent 讀得到；其餘交接檔、人工確認項目、仲裁與車道紀錄會清掉，任務從 T-1 重新編號。
- agent 執行次數上限從目前已執行的次數起算，再加一份額度；可用 `--max-agent-runs <n>` 指定這一輪的額度。
- 第一輪已開過 PR 時，這一輪只推送分支、更新同一個 PR；若 PR 已合併，`iterate` 會拒絕，請改用 `run` 從最新的基底分支開新的 run。

## 停點與專案指令偵測

## 快速流程（`--fast`）

小改動走完整流程，大半成本花在計畫審查。`run --fast` 把規格、計畫與計畫審查換成一次 agent 呼叫：

1. 一個 agent 一次寫出 `spec.md`、`acceptance.json`、`plan.md`、`tasks.json`，任務最多 2 個（`kind: confirm` 的不算）。超過、或任何計畫檔驗證不過（與完整流程用同一套 `validatePlan`），就退回同一個 agent 重寫。
2. 同一次呼叫還要寫 `.flow/fast-check.json`：跨模組、動到公開介面或儲存格式、碰到信任邊界、有未決的重要設計，四項各填 true 或 false。任何一項為 true，或計畫帶著未結的計畫交接事項，程式就丟掉這份計畫、清掉 `fast`，回到完整流程重新產生規格。判斷由程式裁決，agent 只回報事實。
3. 通過後直接定案（與 `replan --no-review` 同一條 `planSettled` 路徑）：確認項目分離、依任務數改算 agent 執行次數上限，`--manual-plan` 時進 `awaiting_approval`。
4. 實作照舊：每個任務依 `tdd` 走紅綠燈，但沒有任務審查，寫完直接驗證；全部完成後仍有整體驗證與程式碼審查。

`--stop-after spec` 與 `--stop-after plan` 都在定案後暫停。fast 的 run 沒有計畫審查階段，所以 `replan` 不適用；`iterate` 開的下一輪沿用 fast。

需要先取用某個階段的產出時，可用 `--stop-after <階段>`。可選停點是 `spec`（規格）、`plan`（計畫審查完成）、`implement`（所有任務完成）、`verify`（測試與 checks 通過）、`review`（程式碼審查完成）或 `pr`（PR 流程完成）。除了 `pr` 會照常結束外，其他停點完成後會進入 `paused`，可檢視 worktree 與 `.flow/` 檔案，再執行 `agentflowctl resume <id>` 從下一階段接續；`--manual-plan` 與 `--stop-after` 不能同時使用。

agentflowctl 會依專案的 `packageManager`、lockfile 與 `package.json` scripts 選擇安裝、測試及檢查指令。偵測到的 `lint` 與 `typecheck`（`type-check`）檢查只在最後整支分支的驗證才跑，每個任務的驗證不跑；`lint` 只檢查整支分支相對基底分支改過的程式檔（排除 `.flow/`，沒有可檢查的檔案就略過；一律沿用專案原本的 lint 設定，agentflowctl 不會修改任何 eslint 設定檔；`lint` script 含 `eslint` 時，偵測到的指令會在指令列加上 `--ignore-pattern` 略過自己產生的 `.flow/`、`.agentflowctl/`，以及本機 git worktree `.worktree/`、`.worktrees/`，避免 `eslint .` 掃到交接檔或別的工作目錄而一直驗證失敗）。只檢查改過的檔案時，這四個目錄也不會被放進檔案清單。預設的測試指令，以及 `test` script 內容含 `vitest` 時，會附加 `--exclude '**/.worktree/**' --exclude '**/.worktrees/**'`（加在專案既有的 exclude 後面，不蓋掉 `node_modules` 等預設，也不改寫 script）。不是 vitest 的測試指令維持原樣。型別檢查仍是整個專案：`tsc` 沒有目錄排除的參數，agentflowctl 也不改寫專案的 tsconfig。`vite build` 同樣無法在不改設定檔時排除目錄，所以 build 指令不加參數。`package.json` 沒有對應 script 時直接略過，不會退回 `npx eslint .` 或 `npx tsc --noEmit`；`build` 在專案有 `package.json`、沒有 `build` script 且看不出是 Vite 專案（沒有 `vite` 依賴、`vite.config.*`、根目錄 `index.html`）時同樣略過，不會去跑 `npx vite build`（沒有 `package.json` 的全新專案仍用預設）；要沿用舊行為，請在 `flow.config.json` 自行寫 `checks`。同一次驗證裡，install 先跑完，其餘檢查預設同時執行（`checksConcurrency` 可限制同時數量，`1` 為一次一個）；結果與 log 仍照設定順序列出。第一次執行時，請留意終端機印出的偵測結果；需要調整可在 `flow.config.json` 指定 `install`、`test` 或 `checks`。`package.json` 的依賴或 `test` script 看不出測試框架（且沒有手動設定 `test`）時，終端機會提示「未偵測到測試框架」，並略過紅綠燈；要改回來，在 `flow.config.json` 設定 `test`。

除了 Node，agentflowctl 也會偵測 Python、Go、Rust；`package.json` 或任一 Node lockfile 優先，其次依序是 `go.mod`、`Cargo.toml`、Python 專案檔。沒有任何可辨識的專案檔（含空資料夾）時視為未辨識：install 為 no-op、不跑任何檢查、不走紅綠燈，需要時在 `flow.config.json` 設定。

| 類型 | 辨識 | install／test／checks | testPattern |
|---|---|---|---|
| Node | `package.json`，或任一 Node lockfile | 見上述（依套件管理器與 scripts） | 沿用預設 |
| Python | `pyproject.toml`、`requirements*.txt`、`setup.py`（或 `setup.cfg`） | 依 `uv.lock`／`poetry.lock`／pip 選套件管理器（`uv sync`、`poetry install --no-interaction`、`pip install -r requirements.txt` 或 `pip install -e .`，uv／poetry 的指令加 `uv run`／`poetry run` 前綴）；test 為 `pytest`（設定或依賴出現 pytest、有 `pytest.ini` 或 `conftest.py`），否則 `python -m unittest discover`；`pyproject.toml` 有 `[tool.ruff` 或有 `ruff.toml` 時加 `ruff check .` 作為最後驗證 | `(^\|/)(test_[^/]*\|[^/]*_test)\.py$` |
| Go | `go.mod` | `go mod download`／`go test ./...`／`go vet ./...`（最後驗證）／`go build ./...` | `_test\.go$` |
| Rust | `Cargo.toml` | `cargo fetch`／`cargo test`／`cargo clippy`（最後驗證）／`cargo build` | `(^\|/)tests/.*\.rs$\|_test\.rs$` |

沒有測試框架時，所有任務不走紅綠燈、不跑 `test` 檢查，終端機印出「未偵測到測試框架」，其餘檢查照常；在 `flow.config.json` 手動設定 `test` 就視為有測試框架。判定方式：

| 類型 | 判定為有測試框架 |
|---|---|
| Node | 依賴含 vitest／jest／mocha 等，或有真正的 `test` script |
| Python | 設定或依賴出現 pytest／unittest，或已有符合 `testPattern` 的測試檔 |
| Go | 已有任何 `*_test.go` |
| Rust | 已有 `tests/` 目錄下的 `.rs` 檔或 `*_test.rs` |

已知限制：Rust 單元測試寫在原始碼內（`#[cfg(test)]`）時不會被看到，專案可能被判定沒有測試框架；這種情況請在 `flow.config.json` 設定 `test`。Python、Go、Rust 的測試檔搜尋最多深入 6 層，並略過 `node_modules`、`venv`、`target` 等依賴與建置目錄。

### 動態偵測

內建偵測認不出類型（未辨識）的專案，`agentflowctl run` 建立 worktree 後、顯示偵測結果與安裝之前，會請一位 agent 讀專案的 `Makefile`、`justfile`、`CMakeLists.txt`、`pom.xml`、`build.gradle*`、`*.sln`／`*.csproj`、`Gemfile`、`composer.json`、`mix.exs`、`.github/workflows/*.yml` 與 README，提出 `install`、`test`、`checks`、`testPattern`，寫成 `.flow/detect-proposal.json`。agent 只能寫 `.flow/`，其他變更會被捨棄。已辨識的類型（Node、Python、Go、Rust）不會觸發。

這是選配功能，不會讓 run 失敗：agent 額度用完或次數上限已到時略過（不找人代打），agent 執行失敗或提案格式不合只印警告。

提案由程式在基底 commit 的臨時 worktree 逐欄位驗證，原則是基底上必須是綠的，不通過的欄位丟掉並印出原因；順序為 install、test、checks（test 與 checks 可能需要先安裝）：

| 欄位 | 驗證 | 不通過時 |
|---|---|---|
| `install`、`test`、`checks[].cmd` | 不是空指令或永遠成功的指令（`true`、`:`、`exit 0`、`echo ...`）；第一個可執行檔存在；在基底上執行成功（每個指令最多 5 分鐘） | 該欄位（或該項檢查）丟掉 |
| `testPattern` | 是合法的正規表示式；專案已有名稱含 test 或 spec 的追蹤檔時，至少要符合其中一個 | 丟掉 |

通過的欄位存進主專案的 `.agentflowctl/detected.json`（不進版控），連同丟掉的原因與指紋。指紋是上述特徵檔與 `.github/workflows/*.yml` 內容的雜湊：指紋沒變就不再呼叫 agent（即使全部欄位都被丟掉也一樣），特徵檔改變後的下一次 `run` 才會重新偵測，指紋不符的 `detected.json` 也不會生效。沒有可用的 `test` 時視為沒有測試框架，不走紅綠燈。

`flow.config.json` 手動設定的 `install`、`test`、`checks`、`testPattern` 一律優先於動態偵測；想固定某個結果，把 `detected.json` 裡的值抄進 `flow.config.json` 即可。
