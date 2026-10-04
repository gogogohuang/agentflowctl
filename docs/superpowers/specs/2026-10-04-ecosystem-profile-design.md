# 與 repo framework 脫鉤：EcosystemProfile 設計

## 目標

agentflowctl 的引擎目前在多處假設目標專案是 Node + Vite + TypeScript + Vitest。目標是讓引擎只依「偵測到的專案資料」運作，Node 專案行為不變，其他生態系統（Python、Go、Rust）與未辨識專案也能走完整流程，守門不失效。

範圍：預設值（A）、依賴目錄（B）、守門與輸出格式（C）、prompt 文字（D）。

## 現況：寫死的位置

- **A 預設值**：`schemas.ts` 的 `RepoConfig` 預設 `install`／`test`／`checks`（`npx tsc`、`eslint`、`vitest`、`vite build`）；`detect.ts` 的 `detectNode` 沒有對應 script 時退回這組、`isNonViteProject` 特例。
- **B 依賴目錄**：`node_modules` 出現在 `tempWorktree.ts`、`engine.ts`（車道 symlink、`excludePaths`、side-effect 過濾）、`cli.ts` 提示、`detect.ts` 的 `SKIP_DIRS`。
- **C 守門與格式**：`testGuard.ts` 的 `sourceOfTest`、`foreignFailingTests`、`SKIP_RE`、`SUPPRESS_RE`、`SOURCE_FILE`、`ASSERT_RE`；`packageExports.ts`（node 的 `require`）；`util.ts` 的 TAP `not ok` 摘要；`acceptanceChecks.ts` 的工具清單。
- **D prompt**：`spec.md`、`fast-plan.md`（package.json、src/）、`plan.md`（`src/form.ts`、tsconfig）、`implement-tests.md`（`@testing-library/react`）、`implement-code.md`（`foo.ts`／`foo.test.ts`）、`detect.md`。

## 設計

### 1. 分層與合併順序

每個欄位依序取第一個有值的來源：

1. `flow.config.json` 手動設定（永遠優先）
2. `detected.json`（generated 提案，程式驗證通過的欄位）
3. 靜態 profile（node／python／go／rust）
4. 都沒有：停用對應守門或功能，run 開始時提示；不退回 JS 預設

generated 觸發：
- 完全未辨識的專案：沿用現有流程（`prompts/detect.md`）。
- 已辨識但 profile 的守門欄位（`skipPatterns`、`suppressPatterns`、`assertPattern`、`failureLine`）有空的，而且專案有測試檔：跑一次。
- 同一個基底 commit 與設定指紋只跑一次。指紋在 `detectFingerprint` 之外納入生態系統名稱。

驗證（程式查事實，不看 agent 的說法）：
- 指令：沿用現行做法，在基底 commit 的臨時 worktree 執行，結束碼 0 才收。
- 正規表示式：必須能編譯；`testPattern` 要比對到專案內至少一個檔案；其他附 `example`，必須比對得到自己的範例。
- 目錄：必須真實存在或被 `.gitignore` 忽略。
- 不通過的欄位丟掉，記進 `detected.json` 的 `dropped`，該守門退到第 4 層。
- 提案只能新增規則：`skipPatterns`、`suppressPatterns` 與 profile 取聯集，不能關掉內建規則或放寬。

### 2. `ProjectDefaults.profile`（`src/detect.ts`）

| 欄位 | 用途 | 取代 |
|---|---|---|
| `depDirs` | 車道與審查者 worktree 共用的依賴目錄 | `node_modules` symlink、side-effect 過濾、`excludePaths` |
| `skipDirs` | `findFiles` 略過的目錄 | `SKIP_DIRS` |
| `sourceExts` | 程式碼副檔名 | `SOURCE_FILE` |
| `skipPatterns` | 新增跳過測試的語法 | `SKIP_RE` |
| `suppressPatterns` | 新增抑制型別／lint 的語法 | `SUPPRESS_RE` |
| `assertPattern` | 斷言行 | `ASSERT_RE` |
| `testSourcePair` | 測試檔對應被測檔 | `sourceOfTest` |
| `testFilePattern`、`failureLine` | 從測試輸出找出失敗的測試檔 | `foreignFailingTests` 的 JS 檔名與失敗行 |
| `failureBlock` | 失敗輸出的區塊格式 | `util.ts` 的 TAP `not ok` |
| `packageProbe` | 紅燈階段套件匯出檢查，只有 node 有 | `packageExports.ts` |
| `hints` | prompt 範例字串 | prompt 內寫死的範例 |

各生態系統：
- **node**：維持現狀，行為不變。
- **python**：`depDirs` 為 `.venv`；跳過 `@pytest.mark.skip`、`@unittest.skip`、`pytest.skip(`；抑制 `# noqa`、`# type: ignore`；斷言含不帶括號的 `assert x == y` 與 `self.assert*`；失敗行 `FAILED path::name`；測試對應 `test_foo.py` ↔ `foo.py`。
- **go**：跳過 `t.Skip(`；抑制 `//nolint`；斷言 `t.Error`／`t.Fatal`／`assert.`／`require.`；失敗區塊 `--- FAIL`；`foo_test.go` ↔ `foo.go`。
- **rust**：`depDirs` 為 `target`；跳過 `#[ignore]`；抑制 `#[allow(`；斷言 `assert!`／`assert_eq!`；失敗區塊 `---- x stdout ----`。
- **未知或缺欄位**：空值，對應守門停用並提示。

`engine.ts` 新增 `projectProfile()`（與 `hasTestFramework()` 同樣讀 `effectiveDefaults`）；`testGuard`、`tempWorktree`、`util` 的相關函式改成接收 profile 參數，不再讀模組常數。`overlayGenerated` 不再限定 `unknown`：已辨識時只補 profile 空著的欄位，不蓋過 profile 已有的值。

### 3. `DetectionProposal` 擴充（`src/schemas.ts`、`src/generateDetected.ts`）

新增選填欄位：`depDirs`、`skipDirs`、`sourceExts`、`skipPatterns`、`suppressPatterns`、`assertPattern`、`failureLine`、`failureBlock`，正規表示式各附 `example`。`validateProposal` 依第 1 節規則驗證。`DetectedFile` 繼承，新欄位全選填，舊檔照常讀得進來。

### 4. `RepoConfig` 中性預設與 Node 偵測依據

- `install` 預設 `NO_INSTALL`、`test` 預設 `true`、`checks` 預設 `[]`。
- `testPattern` 預設改成通用規則，涵蓋 `tests/`、`__tests__/`、`*_test.*`、`test_*`、`*.test.*`、`*.spec.*`，避免手動只寫 `test` 時紅綠燈卡死。
- Vite + TS + Vitest 的字串只留在 `detect.ts` 的 node 區塊。
- `detectNode` 依實際依賴與設定檔決定：
  - 測試：`test` script → 依賴中的框架（vitest → `vitest run`、jest → `jest`、mocha → `mocha`、node:test → `node --test`）→ 沒有就沒有測試框架。
  - `typecheck`：有 script，或有 `tsconfig.json` 且依賴含 typescript。
  - `lint`：有 script，或有 eslint／biome 設定。
  - `build`：只在有 `build` script 時加入；`isNonViteProject` 刪除。
  - vitest／eslint 排除旗標沿用「偵測到才附加」。

### 5. Python 的 pip 環境

只有 `requirements.txt`（沒有 uv／poetry）時，worktree 本來就是隔離環境，所以改用獨立 venv：安裝指令為 `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`，`test`、lint 指令前綴改為 `.venv/bin/`。`pyproject.toml`／`setup.py` 的 pip 路徑同理（`.venv/bin/pip install -e .`）。`depDirs` 含 `.venv`，車道共用。專案日常用法不同時，可在 `flow.config.json` 覆寫。

### 6. Prompt 變數注入（`src/util.ts`、`src/engine.ts`）

- `profile.hints`：`manifestFiles`、`exampleSource`、`exampleTest`、`dependencyNote`。
- engine 新增 `renderStage(name, vars)`，併入 hints 後呼叫 `renderPrompt`；19 處呼叫機械式改名，變數語意不變。
- 沒有 hints 的專案用中性字樣（「專案的依賴檔」、「`<目錄>/<檔名>`」）。
- `prompts/detect.md` 的未辨識說明不再列特定專案檔。
- 新增測試：prompts 底下不得出現 `vitest`、`package.json`、`tsconfig`、`@testing-library` 等字樣。

## 測試

- 每個生態系統的 profile 各有單元測試，用真實 diff 與輸出樣本（含 pytest 的 `FAILED tests/test_x.py::name`）。
- `testGuard` 的 skip、抑制、斷言、`foreignFailingTests`、`sourceOfTest`，每個生態系統各一組案例。
- `validateProposal` 補新欄位：範例比對不到、正規表示式不合法、目錄不存在、提案試圖放寬內建規則。
- 現有 Node 測試不修改，作為行為不變的基準。

## 相容性與文件

- 沒有新增 `FlowRun` 欄位，進行中 run 的 `state.json` 不受影響。
- `detected.json` 新欄位全選填；指紋變動使舊結果失效一次，之後重新偵測。
- `README.md`、`docs/configuration.md`、`examples/flow.config.json` 的偵測說明在對應 commit 一併更新。

## 實作順序

每個 commit 都過 `pnpm run typecheck` 與 `pnpm test`。實際為 5 個 commit（外加審查後的修正）：

0. 基礎：`src/profile.ts`（`EcosystemProfile` 與各生態系統資料，行為不變）。
1. A：中性預設、Node 偵測依據、pip venv。
2. B：`depDirs`、`skipDirs`。
3. C：守門與輸出格式的 profile 化、`DetectionProposal` 擴充、generated 補缺。
4. D：prompt 變數注入。

## 實作時與原設計的差異

- Node 偵測維持現狀：`typecheck`、`lint` 只在專案有對應 script 時加入，不因 `tsconfig.json`／eslint 設定自動補指令。`node:test` 專案靠 `test` script 辨識；沒有 `test` script 時只認依賴裡的 vitest、jest、mocha、ava、jasmine，其他框架視為沒有測試框架。
- `DetectionProposal` 的失敗區塊欄位是列舉 `failureFormat`（`tap`／`pytest`／`go`／`cargo`），沒有 `failureBlock`；agent 只能挑格式，不能提供任意區塊規則。`failureTail(s, max, format?)` 的 `format` 沒有預設值，沒有格式就只取尾端。
- `acceptanceChecks.ts` 的工具清單已含 pytest、ruff、clippy 等，不需要改。
- agent 提案的 `depDirs`／`skipDirs` 由 `isSafeDirName`（單一層路徑、不是 `.`／`..`、不以 `-` 開頭）與 `proposalDirOk`（真實目錄，或 `git check-ignore -q --` 判定被忽略；`depDirs` 還不能是版控追蹤的路徑）驗證。
- `describeDetected` 在守門規則為空時印出提示：未辨識專案一定印，已辨識專案只有欄位為空才印。
- `NEUTRAL_PROFILE.skipDirs` 是舊 `SKIP_DIRS` 的超集合基線，確保沒有偵測結果時略過的目錄不比以前少。
- `withProjectDefaults`：使用者手寫 `test`、偵測結果沒有 `test` 檢查時，補上一筆 `test` 檢查，verify 才會跑它。

## 風險

- C 讓 generated 影響守門：已限制為只能新增規則並由程式驗證範例，仍需在 review 時留意放寬的可能。
- pip 改用 venv 會改變既有 Python 專案的安裝指令；有手動設定的專案不受影響。
- 只以暫存專案驗證過偵測輸出（`config doctor`）；pytest／Go／Rust 專案的完整 run 仍需拿真實專案做一次端到端驗證。
