# 多語言專案偵測（混合式）設計

## 背景
`detect.ts` 只認 Node：沒有對應 script 時退回 `npx vite build`、固定 vitest、固定 JS/TS 測試檔命名。非 Node 專案（例如 devlog-tracker 的 shell/JS 混合專案）會因此被不存在的指令擋在 verify，耗盡任務圈數（`TaskRoundsPause`）。PR #71 先處理 Node 專案裡的 build；本設計把偵測改成不預設 Node。

## 目標與非目標
- 目標：依專案實際狀態決定 install／test／checks／testPattern 與是否走 TDD；找不到就略過，不套用 Node 預設。
- 非目標：不改變手寫 `flow.config.json` 的優先權；不讓 agent 的自述決定關卡（關卡仍由程式跑指令、看結束碼）。

## 優先順序
`loadRepoConfig()` 逐欄位取第一個有值的來源：
1. 手寫 `flow.config.json`
2. `.agentflowctl/detected.json`（動態產生的已驗證結果）
3. 內建偵測（Node、Python、Go、Rust）
4. 略過（無該欄位）

`loadRepoConfig()` 維持同步、無 run 脈絡；動態結果只透過 `detected.json` 進來。

## 測試框架判定（決定要不要走 TDD）
沒有測試框架：所有任務不走紅綠燈、不跑 `test` 檢查、印出「未偵測到測試框架」並說明在 `flow.config.json` 設定 `test` 可改回來；其餘檢查照常。

| 類型 | 判定為有測試框架 |
|---|---|
| Node | 依賴含 vitest／jest／mocha 等，或有真正的 `test` script（現有規則） |
| Python | 依賴或設定出現 pytest／unittest／nose，或已有符合 `testPattern` 的測試檔 |
| Go | 已有任何 `*_test.go` |
| Rust | 已有 `tests/` 目錄或 `*_test.rs`（第一版不看原始碼內的 `#[cfg(test)]`） |
| 動態產生 | `test` 指令通過驗證 |

## 內建偵測
| 類型 | 辨識 | install／test／checks | testPattern |
|---|---|---|---|
| Node | `package.json` | 現有（含 PR #71：非 Vite 無 build script 就略過 build） | 現有 |
| Python | `pyproject.toml`、`requirements*.txt`、`setup.py` | 依 `uv.lock`／`poetry.lock`／pip 選套件管理器；`pytest`；ruff／mypy 只在 pyproject 有設定時加為最後驗證 | `(^\|/)(test_[^/]*\|[^/]*_test)\.py$` |
| Go | `go.mod` | `go mod download`／`go test ./...`／`go vet ./...`（最後驗證）／`go build ./...` | `_test\.go$` |
| Rust | `Cargo.toml` | `cargo fetch`／`cargo test`／`cargo clippy`（最後驗證）／`cargo build` | `(^\|/)tests/.*\.rs$\|_test\.rs$` |

已知限制：Rust 單元測試寫在原始碼內時，紅燈可能被判定沒寫測試；之後另案處理。

## 動態產生（僅在專案類型未知時）
「未知」＝沒有 `package.json`，也不是 Python／Go／Rust。

**時機**：run 建立後、第一個階段前（`cli.ts` 印出偵測結果處）。條件：`detected.json` 不存在，或指紋改變。
**指紋**：特徵檔內容的雜湊，特徵檔為 `Makefile`、`justfile`、`CMakeLists.txt`、`pom.xml`、`build.gradle*`、`*.sln`／`*.csproj`、`Gemfile`、`composer.json`、`mix.exs`、`.github/workflows/*.yml`。
**呼叫**：新模組 `generateDetected.ts` 經 `agentStep()` 呼叫一位 agent（以 run id 為種子挑選，沿用 `roles.ts` 的純函式風格），計入 `maxAgentRuns` 與用量統計。額度不足時略過動態產生並印出原因，不暫停 run（偵測是選配）。
**輸出**：`{ install?, test?, checks[], testPattern? }`，以 zod 驗證，格式不合視為失敗。

### 程式驗證（逐欄位，在基底 commit 的臨時 worktree 內進行，沿用 `tempWorktree.ts`）
原則：基底上必須是綠的，否則 verify 永遠失敗。

| 欄位 | 規則 | 不過的結果 |
|---|---|---|
| `install` | 可執行檔存在、非空指令（`true`、`:`、`echo` 等）；跑一次，exit 0 | 丟掉 |
| `test` | 先跑 install，再跑 test，exit 0；非空指令 | 丟掉，視為無測試框架 |
| `checks` 每項 | 可執行檔存在、非空指令、基底上 exit 0 | 只丟該項 |
| `testPattern` | 能編譯；專案已有檔名含 `test`／`spec` 的追蹤檔時至少命中一個 | 丟掉，退回預設 |

每個指令逾時 5 分鐘（算不過）。保留項目與丟棄原因都印在終端機，並提示可複製進 `flow.config.json` 固定。通過的結果寫入 `detected.json`；全部無效也寫入一份「已嘗試」紀錄（帶指紋），避免每個 run 重複花用量。

## 影響範圍
- `src/detect.ts`：拆出各類型偵測、測試框架判定；`ProjectDefaults` 增加 `testPattern`。
- `src/generateDetected.ts`（新）：產生與驗證。
- `src/engine.ts`：`loadRepoConfig` 合併 `detected.json`；`hasTestFramework` 沿用判定。
- `src/schemas.ts`：`RepoConfig.testPattern` 不再固定預設，改由偵測結果補；`DetectedFile` 結構。
- `src/dump.ts`：`RUN_ENTRIES` 不變（`detected.json` 在專案層級，不屬於單一 run）；文件註明。
- `prompts/`：`testPattern` 已是變數，不需改；檢查其中是否還有寫死 vitest／JS 的說明。
- `README.md`、`docs/workflow.md`、`docs/configuration.md`：同步說明。
- 測試：`detect.test.ts` 各類型與判定、`generateDetected.test.ts`（以注入的假 agent 與假指令驗證各欄位的保留與丟棄）。

## 實作順序（同一個 PR，依序提交）
1. 內建 Python／Go／Rust 偵測＋測試框架判定＋ testPattern 偵測（純函式，不花用量）。
2. 動態產生與驗證＋ `detected.json`。
