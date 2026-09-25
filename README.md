# agentflowctl

一個**跨廠商的 AI 開發 harness**：讓 Claude Code、Codex、Gemini CLI（或任何 agent CLI）在同一條流程裡**輪流實作、互相審查、互相修正**。

```
需求 → spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁 → implement（測試 A → 實作 B）→ verify ⇄ fix → review ⇄ fix → pr
```

從需求到 PR **全程不需要人介入**：計畫和程式碼一樣，由不同公司的模型互相審查、修改；審查僵持不下時交付仲裁。**兩家模型就能完整運作**，有第三家時仲裁會更獨立。

每個步驟都是一次獨立的 agent 執行，用 `.flow/` 裡的檔案交接；是否通過一律由程式實際檢查（跑測試、比對 git diff、驗證 JSON），不相信任何一家模型自己說「完成了」。

## 為什麼要讓不同公司的模型互相循環

同一個模型審查自己的程式碼，很容易對自己的寫法有盲點；測試和實作出自同一個模型，也容易「寫出剛好會過的測試」。agentflowctl 用三條規則打破這種同溫層：

| 規則 | 效果 |
|---|---|
| **審查者永遠不是最後寫程式的 agent** | 每一輪審查都是「別家」在看 |
| **同一個任務的測試與實作由不同 agent 負責**（`tddSplit`） | A 寫的測試，B 必須實作到通過，而且不能改測試 |
| **所有角色沿著同一個輪替順序前進** | 三家輪流扮演作者、審查者、修正者 |

最常見的是兩家，例如輪替順序 `claude → codex`，實際跑出來是很乾淨的乒乓模式：

```
計畫：claude 撰寫 → codex 審查（要求修改）→ claude 修改 → codex 審查（核准）
T-1  測試：claude   實作：codex
T-2  測試：codex    實作：claude
審查：codex（最後作者是 claude）→ 要求修改 → claude 修正 → codex 審查（核准）
```

有三家時，修正與審查會一直換人（例如 codex 寫、gemini 審、claude 修），仲裁也能交給完全沒參與的第三方。

每個 commit 的訊息結尾都會標上作者，例如 `feat(T-2): 匯出 [gemini]`，事後可以清楚看到每一段程式碼是哪家模型寫的、哪家審過。

## 在任何環境都能用

agentflowctl 本身只需要 **Node.js 22 以上與 git**，其他全部透過各家的 CLI 執行：

| 環境 | 說明 |
|---|---|
| macOS、Linux、Windows | 專案指令透過系統 shell 執行，git 操作不依賴任何平台專屬路徑 |
| CI（GitHub Actions 等） | 見 `examples/github-actions.yml`：issue 加上標籤就自動跑完並開 PR |
| 容器、遠端開發機 | 可丟棄的環境最適合完全無人值守地執行 |
| 在 Claude Code、Codex 裡面 | 讓它們用 shell 執行 `agentflowctl`，或之後包成 MCP server |

執行前先檢查環境：

```bash
agentflowctl doctor
# ✅ claude     adapter=claude
# ✅ codex      adapter=codex
# ❌ gemini     adapter=gemini
# 輪替順序：claude → codex
```

沒有設定輪替順序時，agentflowctl 會自動偵測已安裝的 CLI。只裝一家也能運作，只是失去交叉審查的好處。

## 安裝

```bash
pnpm install
pnpm run build
pnpm link --global
```

預設使用各家 CLI 的**訂閱登入**，不會產生額外的 API 費用：先分別執行 `claude`、`codex` 完成登入，再用 `agentflowctl doctor` 確認。詳見下方「訂閱登入與額度」。

## 使用方式

在專案資料夾內執行：

```bash
agentflowctl run --req "登入表單加上 zod 驗證與錯誤訊息"
agentflowctl run --req-file ./req.md --cycle codex,claude --max-agent-runs 40
agentflowctl run --req "..." --manual-plan   # 計畫通過 AI 審查後，仍停下來讓你確認

agentflowctl approve f-xxxx        # 搭配 --manual-plan 時核准計畫
agentflowctl status f-xxxx         # 階段、任務進度、各 agent 的用量
agentflowctl list
agentflowctl logs f-xxxx --latest
agentflowctl resume f-xxxx         # 從暫停或失敗處接續，可加 --max-agent-runs
agentflowctl cancel f-xxxx
agentflowctl clean f-xxxx          # 移除 worktree，分支保留
```

每個 run 都在專案內的專用 git worktree（`.agentflowctl/worktrees/<id>`）工作，不會碰到你正在編輯的檔案。

## 設定：`flow.config.json`

放在專案根目錄，完整範例見 `examples/flow.config.json`。

```json
{
  "cycle": ["claude", "codex"],
  "fixStrategy": "ring",
  "tddSplit": true,
  "tieBreak": "proceed",
  "agents": {
    "codex": { "adapter": "codex", "model": "你要用的模型", "pricing": { "inputPerMTok": 1.25, "outputPerMTok": 10 } },
    "aider": { "adapter": "command", "command": ["aider", "--yes-always", "--no-auto-commits", "--message", "{prompt}"] }
  }
}
```

| 設定 | 說明 |
|---|---|
| `cycle` | 輪替順序；同一家也可以放不同模型，例如定義 `claude-fast` 與 `claude-strong` 兩個 agent |
| `fixStrategy` | `ring`：審查意見交給審查者的下一位修正（三家時會一直換人）；`author`：交回作者修正 |
| `tddSplit` | 測試與實作是否交給不同 agent |
| `reviewQuorum` | 程式碼需要幾位不同的審查者都核准；設成 2 就是「兩家都同意才過」 |
| `planReviewQuorum` | 計畫需要幾位不同的審查者都核准 |
| `planArbiter` | 計畫審查僵持時是否交付仲裁（預設開啟）；關閉的話僵持會直接失敗，等人處理 |
| `tieBreak` | 仲裁意見分歧時：`proceed`（預設）繼續實作並記錄爭議；`stop` 停下來等人 |
| `auth` | `subscription`（預設）移除環境中的 API key，只用訂閱登入；`api` 保留 API key |
| `maxAgentRuns` | 單一 run 最多執行幾次 agent，預設 60 |
| `agents` | 覆寫內建的 `claude`、`codex`、`gemini`，或用 `command` adapter 接上任何其他 CLI |

verify 失敗（型別、lint、建置錯誤）一律交回最後的作者修正，因為這類機械性錯誤由作者處理最快；只有審查意見才依 `fixStrategy` 輪替。

## 計畫審查怎麼做到不需要人

人工確認計畫原本是為了擋住「方向錯了還一路做下去」。agentflowctl 用三層機制取代它：

**第一層：確定性檢查。** 每次計畫被撰寫或修改後，都要重新通過格式、任務相依與驗收條件覆蓋率的檢查，沒過就還原。

**第二層：跨模型審查。** 審查重點是需求覆蓋、驗收條件能否測試、任務大小與技術方向。審查者只能寫出意見，若偷改規格或計畫，agentflowctl 會把檔案還原；修改者必須在 `plan.md` 的「審查回應」逐條回覆，不同意的意見要寫理由，不能直接忽略。

**第三層：僵持時仲裁。** 兩種情況會觸發：審查意見和上一輪完全一樣（修改沒有進展），或已達重試上限。仲裁者只判斷一件事：照這份計畫實作，能不能正確滿足需求。誰來仲裁取決於有幾家：

| 情況 | 仲裁方式 | 結果 |
| --- | --- | --- |
| 有第三家 | 沒參與討論的第三方單獨仲裁 | 核准就繼續，否則停下 |
| 只有兩家 | **雙盲交叉仲裁**：兩家各自在全新 context 中判斷 | 一致核准就繼續；都不核准就停下；分歧依 `tieBreak` |

只有兩家時，不能讓一直提反對意見的審查者同時當裁判，所以改成兩家各自仲裁，並且做到**雙盲**：仲裁者看到的只有計畫與一份不含任何模型名稱的爭議清單（`.flow/dispute.md`），看不出誰是作者、誰是審查者；帶有名稱的審查紀錄都移到 worktree 以外。`tieBreak` 預設為 `proceed`，理由是計畫之後還有紅綠燈、驗證與程式碼審查等確定性關卡把關，有瑕疵的計畫很難一路通過到 PR。

裁決結果與每位仲裁者的理由會附在 `plan.md` 最後的「仲裁紀錄」。所有審查與仲裁的原始紀錄保存在 `.agentflowctl/runs/<id>/reviews/`，事後可以完整追溯每一輪誰提了什麼。

## Adapter

| adapter | 執行方式 | 權限控制 |
|---|---|---|
| `claude` | `claude -p --output-format stream-json` | acceptEdits、禁止 git 寫入指令、內建沙箱（設定檔在 `.agentflowctl/runs/<id>/claude-settings.json`） |
| `codex` | `codex exec --json --sandbox workspace-write -`（prompt 走 stdin） | 只能修改工作目錄，預設不能連網 |
| `gemini` | `gemini -p --output-format stream-json --approval-mode yolo` | 沒有細緻權限，建議在 `extraArgs` 加 `--sandbox` 或在可丟棄環境執行 |
| `command` | 任意指令，`{prompt}` 替換或走 stdin | 取決於該工具 |

Codex 的沙箱不能連網，所以 agentflowctl 在建立 worktree 時會先執行 `install` 把相依套件裝好。各家 CLI 的參數與事件格式更新得很快，第一次使用前請先用 `agentflowctl doctor` 與一個小需求實測。

每家 agent 讀取的專案說明檔不同（Claude Code 讀 `CLAUDE.md`、Codex 讀 `AGENTS.md`、Gemini 讀 `GEMINI.md`）。建議把專案慣例寫在 `AGENTS.md`，另外兩個檔案用一行引用它，確保三家看到的規則一致。agentflowctl 的 prompt 本身不依賴任何一家的 skills 或 plugins。

## 各階段與關卡

| 階段 | 負責的 agent | 通過條件（由程式判斷） | 失敗時 |
|---|---|---|---|
| spec | 輪替順序第 1 位 | 檔案存在、zod 驗證、id 不重複 | 重試 |
| plan | 輪替順序第 1 位 | zod 驗證、相依存在、無循環、每條驗收條件都有任務負責 | 重試 |
| plan_review | 非計畫作者的下一位（可多位） | 所有審查者都 `approve` | 進入 plan_fix |
| plan_fix | 審查者的下一位 | 修改後仍通過 plan 的所有格式與 DAG 檢查 | 還原並重試 |
| 仲裁 | 有第三家：第三方；只有兩家：兩家雙盲各自仲裁 | 一致核准；分歧依 `tieBreak` | 都不核准（或 `tieBreak: stop`）時 run 失敗，這時才需要人 |
| 人工確認 | 你（只有 `--manual-plan` 時） | `agentflowctl approve` | — |
| implement（紅燈） | 第 i 個任務由第 i 位 | 有測試變更，且執行後**失敗** | 還原並重試 |
| implement（綠燈） | 測試作者的下一位 | 測試檔**完全沒被修改**，且測試通過 | 還原或帶著輸出重試 |
| verify | — | install 與所有 checks 通過 | 交回作者修正 |
| review | 非作者的下一位（可多位） | 所有審查者都 `approve` | 依 `fixStrategy` 交給下一位修正 |
| pr | — | push 成功，有 `gh` 就開 PR | — |

## 訂閱登入與額度

agentflowctl 預設 `auth: "subscription"`，只使用各家 CLI 的訂閱登入。

**不會意外改走 API 計費。** 環境變數中的 API key 會蓋過訂閱登入，所以 agentflowctl 執行 agent 時，會從子程序環境中移除 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CODEX_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`。`agentflowctl doctor` 發現這些變數時也會提醒你。專案指令（install、test、build）不受影響。

**用量上限取代金額預算。** 訂閱制下花費不是實際扣款，所以預設以「agent 執行次數」為上限（`maxAgentRuns`，預設 60 次）。Claude Code 回報的美元金額只是換算 API 價格的估計值，僅供參考。

**額度用完時，審查停下、其他步驟代打。**

| 步驟 | 額度用完時 | 理由 |
| --- | --- | --- |
| 計畫審查、程式碼審查、仲裁 | **暫停**，等額度恢復後 `agentflowctl resume` | 由另一家代審，可能變成作者審查自己，失去交叉審查的意義 |
| 規格、計畫、修改計畫、寫測試、寫實作、修正 | **由另一家代打**，繼續執行 | 撰寫品質之後仍有審查把關 |
| 所有 agent 的額度都用完 | 暫停 | — |

換人或暫停前，額度用完的 agent 留下的半成品會先被清掉。代打會記錄在 `.agentflowctl/runs/<id>/substitutions.jsonl`，`agentflowctl status` 也會列出；commit 結尾標註的是實際執行的模型。

代打有一個已知的取捨：如果寫實作的一方額度用完，由寫測試的那一家代打，這個任務的測試與實作就會出自同一家，`status` 會特別標註。這也是為什麼審查步驟必須等原本的另一家：它是這種情況下唯一的交叉檢查。

額度相關錯誤是用錯誤訊息比對辨識的（usage limit、rate limit、quota、429 等），只在 agent 執行失敗時才判斷。各家訊息可能隨版本改變，辨識失敗時會被當成一般失敗重試。

**使用 API 的情況。** 例如在 CI 中無法使用訂閱登入，在 `flow.config.json` 設定 `"auth": "api"` 保留 API key，並可用 `--budget` 設定估計花費上限。Codex、Gemini 只回報 token，需要在 `agents.<name>.pricing` 設定價格才會算進預算。

## 安全性

沒有容器隔離時，**verify 階段會直接在你的電腦上執行 agent 寫出來的程式碼**，而且各家 CLI 的權限模型強弱不一（Gemini 在無人值守時只能 yolo）。因此：

- 在你自己的電腦上：用在自己的專案、需求由你撰寫；剛開始使用時可以加上 `--manual-plan`，確認 AI 審查的品質後再拿掉。
- 要無人值守或處理外部 issue：放到 CI runner 或容器這類可丟棄的環境。
- 不要把來路不明的 issue 內容直接交給 agentflowctl 在本機執行，需求文字本身就可能夾帶惡意指示；AI 審查計畫並不能擋住這類攻擊。

## 專案結構

```
src/
  cli.ts            指令列介面（run、doctor、status……）
  engine.ts         狀態機與各階段邏輯
  roles.ts          誰負責哪個步驟的輪替規則（含計畫修正者與仲裁者）
  runner.ts         執行 agent 並正規化結果、執行專案指令
  agents/           claude、codex、gemini、command 四種 adapter
  git.ts            worktree 與安全的 git 操作
  store.ts          以檔案儲存狀態與各 agent 的花費
  tasks.ts          任務 DAG 驗證與排序
  schemas.ts        所有 zod schema
prompts/            各階段 prompt（不依賴任何一家的專屬功能）
examples/           flow.config.json 與 GitHub Actions 範例
```

## 開發

```bash
pnpm run typecheck
pnpm test   # 輪替規則、各 adapter 的事件解析、worktree、儲存、任務 DAG
```

## 授權

MIT，詳見 [LICENSE](LICENSE)。
