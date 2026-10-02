# 降低 codex 用量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 codex 在 flow run 裡每個 5 小時 window 能做完更多任務：先量出各項改善實際省多少，再只保留有效的。

**Architecture:** 分三層。一、不改程式的設定（adaptive 選模、codex `extraArgs`），先實測再採用；二、改 prompt，要求 agent 不重複執行同一個驗證指令；三、讀 log 找出 T-1 反覆重試的原因，決定要不要再改程式。所有改動都以「同一份 `costs.jsonl` 對照」驗收，不憑感覺。

**Tech Stack:** Node.js 22、TypeScript、Vitest、Codex CLI（`codex exec --json`）。

**Spec:** 無獨立 spec。依據是本對話對 run `f-muqd84lu`（`/Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/runs/f-muqd84lu/`）的 `costs.jsonl` 與 logs 分析。

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出都用繁體中文。
- 關卡判斷只看程式能檢查的事實，不改成依賴 agent 回覆內容（`AGENTS.md`）。
- 規則「審查者不能是最後的作者」（`roles.ts` 規則 1）不能放寬。
- 改變使用者看得到的行為（指令、選項、設定欄位、終端機輸出、階段流程）時，同一個 commit 要更新 `README.md`。只改 prompt 文字不算。
- 不使用環境變數；設定放 `flow.config.json`。
- 動目標專案 `taxigo_console` 的 `flow.config.json` 前先取得使用者同意。

## 已知事實（計畫的依據）

| 事實 | 來源 |
|---|---|
| 34 筆有效紀錄共 10,047,241 tokens；codex 5,842,720（58.2%）、claude 4,204,521（41.8%） | `costs.jsonl` |
| cache 讀占輸入 87.7%，每次呼叫新輸入只有 1.6 萬到 6 萬 | `costs.jsonl` |
| T-1 共 11 次呼叫、3,287,077 tokens（32.7%）；其中 codex（sol）7 次 `T-1-code` 約 200 萬 | `costs.jsonl`、`retries.jsonl` |
| T-1 重試原因：`tests_not_green` 3 次、`tests_invalid` 2 次 | `retries.jsonl` |
| 一輪 codex 呼叫執行 18 到 20 個 shell 指令，包含重複的 vitest、`pnpm type-check && pnpm lint`、`git diff --check` | `logs/008-implement-T-1-code-codex.log` 等 |
| codex 每次先 `cat` superpowers 的 `using-superpowers` skill，再讀 `.flow/handoff-context.md` | 同上 |
| sol 12 次是因為 `flow.config.json` 在 03:50 UTC 前把 `model` 設為 sol，之後改為 terra（推斷，未見改動內容） | config 修改時間與模型切換時間 |
| 12 個任務只做到 T-7，剩餘 T-7 到 T-12 | `state.json`、`tasks.json` |
| codex usage limit 在 04:02 UTC 觸發，14:02（本地）恢復 | `logs/071-implement-T-7-code-codex.log` |

## 不採用的改善：「review 少給 codex」

先前提過把 review 偏向 claude。**這個做法要撤回**：只有兩家 agent 時，claude 寫程式後審查者只能是 codex（`roles.ts` 規則 1），強行排除 codex 會變成 claude 自己審自己。想降低 review 的用量，改用 Task 4 的 adaptive 選模，讓 review 步驟用較低強度的模型。

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `prompts/implement-code.md` | Modify | 綠燈實作 prompt：加入「同一個指令不重複執行」的限制 |
| `prompts/implement-tests.md` | Modify | 紅燈測試 prompt：同上 |
| `src/prompts.test.ts` | Modify | 新增斷言，確認兩個 prompt 都有這條限制 |
| `docs/superpowers/plans/2026-10-02-codex-usage-reduction.md` | Create | 本計畫 |
| 目標專案 `flow.config.json` | Modify（需使用者同意） | codex `extraArgs`、`modelSelection.mode` |

只有 Task 3 動這個 repo 的程式碼檔案；其他任務是量測、設定與讀 log。

---

### Task 1: 建立基準數字

**Files:**
- Read: `/Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/runs/f-muqd84lu/costs.jsonl`

**Interfaces:**
- Produces: 下面三個基準值，後面各任務拿來比對。

- [ ] **Step 1: 產出每次呼叫的基準**

Run:

```bash
cd /Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/runs/f-muqd84lu && node -e '
const rows=require("fs").readFileSync("costs.jsonl","utf8").trim().split("\n").map(JSON.parse).filter(r=>r.inputTokens!=null);
const by=(k)=>rows.filter(r=>r.agent=="codex"&&k(r));
const avg=(a)=>Math.round(a.reduce((s,r)=>s+r.inputTokens+r.outputTokens,0)/a.length);
console.log("codex 每次平均",avg(by(()=>true)));
console.log("codex code 每次平均",avg(by(r=>/-code$/.test(r.stage))));
console.log("codex review 每次平均",avg(by(r=>/-review$/.test(r.stage))));
console.log("codex tests 每次平均",avg(by(r=>/-tests$/.test(r.stage))));'
```

Expected: 印出四個數字。把它們抄進 Task 6 的比對表「基準」欄。這份基準以目前 config（terra）混合 sol 的紀錄為準，所以只能和「同階段」比較，不要用 sol 與 terra 混合的總平均當唯一依據。

- [ ] **Step 2: 記錄 codex 單次指令數**

Run:

```bash
cd /Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/runs/f-muqd84lu/logs && for f in *-codex.log; do echo "$f $(grep -c '"type":"command_execution"' $f)"; done
```

Expected: 每個 log 一行。T-1-code 約 20、review 約 18。抄進基準欄。

---

### Task 2: 實測 `--disable plugins` 能省多少

目的：確認 codex 每次先讀 superpowers skill 是不是 plugin 載入造成，以及關掉後會不會省 token。**沒有實測前不寫進設定**，因為 `plugins` 被停用可能連專案需要的 plugin 一起關掉。

**Files:**
- 暫存：scratchpad 內的實驗目錄，不進 repo。

**Interfaces:**
- Produces: 「關 plugins 前後」同一個 prompt 的 `input_tokens` 對照，決定 Task 5 要不要寫入 config。

- [ ] **Step 1: 準備同一個固定 prompt**

在 scratchpad 建 `probe.txt`，內容：

```
請列出目前目錄的檔案名稱，只回覆檔名，不要修改任何東西。
```

- [ ] **Step 2: 執行不關閉 plugin 的版本**

Run（在目標專案 worktree 或任一小 git repo 內）：

```bash
codex exec --json --sandbox read-only --skip-git-repo-check -m gpt-5.6-terra - < probe.txt | grep '"turn.completed"'
```

Expected: 一行含 `usage.input_tokens`。記下 `input_tokens` 與 `cached_input_tokens`。

- [ ] **Step 3: 執行關閉 plugin 的版本**

Run:

```bash
codex exec --json --sandbox read-only --skip-git-repo-check -m gpt-5.6-terra --disable plugins - < probe.txt | grep '"turn.completed"'
```

Expected: 一行含 `usage.input_tokens`。

- [ ] **Step 4: 判斷**

- 若關閉後的 `input_tokens` 少了 3 萬以上，且 log 裡不再 `cat` superpowers skill：採用，進入 Task 5。
- 若差異小於 1 萬：不採用，在本計畫「結果」補一行原因，跳過 Task 5 的 `extraArgs` 步驟。
- 若 codex 回報 `--disable plugins` 不是有效參數：改試 `-c 'features.plugins=false'`，仍失敗就放棄並記錄。

---

### Task 3: prompt 加入「同一個指令不重複執行」（已完成：分支 `fix/prompt-no-repeat-commands`，commit 572435e）

**Files:**
- Modify: `prompts/implement-code.md`（`<constraints>` 區塊）
- Modify: `prompts/implement-tests.md`（`<constraints>` 區塊，約第 45 行）
- Test: `src/prompts.test.ts`

**Interfaces:**
- Consumes: `renderPrompt(name, vars)`（`src/util.ts`），`names` 與 `vars` 已在測試檔頂端定義。
- Produces: 兩個 prompt 都含有「同一個指令」這句限制，無新變數，所以 `engine.ts` 的 `renderPrompt` 呼叫不用改。

- [ ] **Step 1: 寫失敗的測試**

在 `src/prompts.test.ts` 的 `describe("prompts", ...)` 區塊末端加入：

```ts
  it.each(["implement-code", "implement-tests"])("%s 要求沒修改時不重跑同一個指令，修改後仍可重跑", (name) => {
    const text = renderPrompt(name, vars);
    expect(text).toContain("沒有修改任何檔案時，不要重跑同一個指令");
    expect(text).toContain("修改後可以再跑一次確認");
  });
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run src/prompts.test.ts -t "沒修改時不重跑"`
Expected: 2 個 FAIL，訊息為 `expected ... to contain '同一個指令'`。

- [ ] **Step 3: 在兩個 prompt 的 `<constraints>` 加一行**

`prompts/implement-code.md` 的 `<constraints>` 區塊，在「不要執行 git commit」那行之後加入：

```
- 沒有修改任何檔案時，不要重跑同一個指令（測試、`type-check`、`lint`、`git diff --check`）；修改後可以再跑一次確認。外部流程會用 `{{testCmd}}` 驗證全部測試。
```

`prompts/implement-tests.md` 的 `<constraints>` 區塊，在「不要執行 git commit」那行之後加入：

```
- 沒有修改任何檔案時，不要重跑同一個指令（測試、`type-check`、`lint`、`git diff --check`）；修改後可以再跑一次確認。
```

注意 `implement-tests.md` 沒有 `{{testCmd}}` 以外的新變數，所以第二行故意不引用變數。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run src/prompts.test.ts`
Expected: 全部 PASS，包含原本每個 prompt 的 `<role>`、`<reply_format>` 檢查。

- [ ] **Step 5: 跑型別與全部測試**

Run: `pnpm run typecheck && pnpm test`
Expected: 兩者皆通過。

- [ ] **Step 6: Commit**

```bash
git add prompts/implement-code.md prompts/implement-tests.md src/prompts.test.ts
git commit -m "prompt 限制改成沒修改檔案時不重跑，修改後仍可再跑一次確認"
```

只改 prompt 文字、不改指令或設定欄位，所以不更新 `README.md`。

---

### Task 4: 試用 adaptive 選模（已完成；只影響新建 run）

目的：讓 low 複雜度任務與 review 用低強度模型。目標專案 config 已登記 `gpt-6.1-sol`（high）、`gpt-5.6-terra`（medium）、`gpt-6-luna`（low）。

**Files:**
- Modify: 目標專案 `flow.config.json`（只用 `config` 指令改，不手改 JSON）

**Interfaces:**
- Consumes: `modelSelection.ts` 的 `selectModel`：stage 的最低強度預設是 `taskTests`、`taskCode`、`taskFix` 為 low，`taskReview` 為 medium，`plan`、`planReview`、`review` 為 high，任務的 `complexity` 會抬高 task 類階段的下限。
- Produces: `modelSelection.mode = "adaptive"`。

- [ ] **Step 1: 看目前各階段實際生效的強度**

Run:

```bash
cd /Users/gogogohuang/Documents/work/line_go/taxigo_console && /Users/gogogohuang/Documents/p/project/agentflowctl/node_modules/.bin/tsx /Users/gogogohuang/Documents/p/project/agentflowctl/src/cli.ts config selection stage
```

Expected: 列出 11 個階段與強度（預設），與上面描述一致。

- [x] **Step 2: 取得使用者同意後切換模式**（2026-10-02 已執行，改前備份在 `/private/tmp/claude-501/flow.config.json.bak`）

Run:

```bash
… config selection mode adaptive
```

Expected: 設定寫入成功。**這只影響之後新建的 run**：`modelMode` 在建立 run 時就寫進 `state.json`，f-muqd84lu 已記為 `balanced`，不會改變，也沒有 CLI 指令能改進行中 run 的模式。若報「缺 models」，用 `config agent model add` 補（claude 也要有 `models`，adaptive 只看 `models`，不看 `model`）。

- [ ] **Step 3: 檢查任務複雜度**

目前 T-4 以後多數是 `low`，T-1 到 T-3、T-11 是 `high`。adaptive 下 `high` 任務的 code、tests 會用 sol 或 claude 的高強度模型，這部分不會省，要靠 Task 6 診斷後用 `replan` 切小任務處理。

- [ ] **Step 4: 風險確認**

luna 寫出的測試或實作品質較低時，`tests_not_green` 與 `tests_invalid` 重試會增加，反而更耗額度。若 Task 6 發現重試次數上升，就用 `config selection stage taskCode medium` 把 task 類階段的下限調回 medium。

---

### Task 5: 套用 codex `extraArgs`（僅在 Task 2 判定採用時）

**Files:**
- Modify: 目標專案 `flow.config.json` 的 `agents.codex.extraArgs`

**Interfaces:**
- Consumes: `src/agents/codex.ts` 的 `invoke`，`extraArgs` 放在 `-c model_reasoning_effort=...` 之後、結尾 `-` 之前。
- Produces: codex 每次呼叫帶 `--disable plugins`。

- [ ] **Step 1: 設定**

Run:

```bash
… config agent set codex --extra-arg=--disable --extra-arg=plugins
```

Expected: 寫入成功。`config agent list` 顯示 `extraArgs=--disable plugins`。以 `-` 開頭的值必須寫成 `--extra-arg=--disable`（`src/cli.ts:430`），不能把值當成獨立參數；`--extra-arg` 會整個取代原本的 `extraArgs`。也可以直接編輯 `flow.config.json`，並先取得使用者同意。

- [ ] **Step 2: 確認 adaptive 沒衝突**

README 規定 adaptive 下 `extraArgs` 不能放 `--effort` 或 `model_reasoning_effort`；`--disable plugins` 不在限制內。

- [ ] **Step 3: 小驗證**

Run:

```bash
… config agent model check
```

Expected: 通過。注意探測流程本來就不沿用 `extraArgs`，所以這一步只確認模型清單仍有效，不能證明 `--disable plugins` 在真實呼叫可用；真正的驗證在 Task 7。

---

### Task 6: 診斷 T-1 為什麼一直重試（唯讀）

目的：T-1 占 32.7%，重試原因是 `tests_not_green`×3 與 `tests_invalid`×2。先找根因再決定要不要改程式，不憑猜測。

**Files:**
- Read: `logs/008`、`010`、`012`、`014`、`018`、`020`、`024`（T-1-code），`logs/` 中 T-1-tests、T-1-green、T-1-review 對應的 log
- Read: `/Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/worktrees/f-muqd84lu/.flow/feedback.md`（若還在）

**Interfaces:**
- Produces: 一段結論，三選一：任務切太大、測試本身不穩、prompt 沒講清楚。

- [ ] **Step 1: 看每次重試的失敗訊息**

Run:

```bash
cd /Users/gogogohuang/Documents/work/line_go/taxigo_console/.agentflowctl/runs/f-muqd84lu && cut -c1-300 retries.jsonl && agentflowctl logs f-muqd84lu 2>/dev/null | head -80
```

（`agentflowctl` 用 `tsx` 路徑代替，同 Task 4。）
Expected: 看到每次 `T-1:code` 退回的原因與編號。

- [ ] **Step 2: 看 `tests_invalid` 那兩次**

Run:

```bash
… logs f-muqd84lu 010 --full
```

找「測試本身有問題」的判斷依據：是測試用了不存在的 mock，還是 T-1 的驗收條件與測試對不上。

- [ ] **Step 3: 下結論並分流**

- **任務切太大：** 回頭在 `replan`（`agentflowctl replan <id>`）補意見要求把 T-1 拆小。
- **測試不穩：** 把問題記成 `.flow` 的 handoff 事項，不改程式。
- **prompt 沒講清楚：** 另開一個計畫修 `prompts/implement-tests.md`，不要併進本計畫。

---

### Task 7: 續跑並比對

**Files:**
- Read: 同一個 run 的新 `costs.jsonl`

**Interfaces:**
- Consumes: Task 1 的基準；Task 3、4、5 的改動。

- [ ] **Step 1: 等 codex 額度恢復後續跑**

14:02（本地）後：

```bash
… resume f-muqd84lu
```

Expected: 從 T-7 接著跑。T-7-code 先前被代打成 claude，這會讓額度壓力暫時轉到 claude，要留意 claude 的用量。

- [ ] **Step 2: 用同一份腳本比對**

重新執行 Task 1 的腳本，只看 T-7 之後新增的紀錄（`at` 晚於 04:02:15）。

| 指標 | 基準 | 目標 |
|---|---|---|
| codex code 每次平均 tokens | 以 Task 1 為準 | 降低 15% 以上 |
| codex 單次 shell 指令數 | 約 18 到 20 | 降到 12 以下 |
| 重試次數 | T-1 有 5 次 | 後續任務不增加 |

- [ ] **Step 3: 判斷**

- 指令數沒降：Task 3 的 prompt 沒有效，改成在 prompt 裡列出具體要避免的指令，或在 adapter 加 `--sandbox` 限制（需另開計畫）。
- token 沒降但指令數降了：重送上下文的成本主要在 cache 讀，影響有限，接受這個結果。
- 重試增加：回到 Task 4 Step 4 調高 task 類階段下限。

---

## 執行順序與依賴

1. Task 1（基準）與 Task 6（診斷）可同時做，彼此獨立。
2. Task 2 在 Task 5 之前。
3. Task 3 可獨立先做、先 commit。
4. Task 4、Task 5 要使用者同意後才動 config。
5. Task 7 在額度恢復後最後執行。

## Self-Review

- **Spec coverage：** 先前提出的六項改善都有對應或明確處置：review 少給 codex → 撤回並說明原因；關 superpowers → Task 2 與 5；等額度並續跑 → Task 7；adaptive → Task 4；T-1 重試 → Task 6；減少重複指令 → Task 3。
- **Placeholders：** Task 3 有完整測試與 prompt 文字；其他任務是設定與唯讀診斷，指令都已寫出。以 `…` 代表 `cd` 到目標專案並以 `tsx` 執行 `src/cli.ts`，已在 Task 4 Step 1 示範完整形式。
- **型別一致：** 只用到既有的 `renderPrompt`、`names`、`vars`，沒有新增函式或型別。
- **已知限制：** 「關 plugins 能省多少」和「prompt 能不能減少重複指令」都是假設，要靠 Task 2 與 Task 7 的數字驗證；未驗證前不要寫進 README 或宣稱有效。
