# Insights 計畫審查與後續修正計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 `feat/run-insights` 目前的程式為準，審查 `2026-09-28-run-insights.md` 與 `2026-09-28-usage-insights.md`，列出計畫與實作不一致、計畫本身的設計問題，並安排收尾工作。

> **狀態：已完成。** Task 1 → d98764c，Task 2 → 50ac2d3，Task 3 與三份 insights 計畫一起 commit。`2026-09-28-plan-review-layers.md` 屬於另一項工作，沒有一起提交。

**審查基準：** `feat/run-insights` @ `4b87c45`，加上尚未 commit 的修正（跨 run 不以 task id 合併用量與步驟、`retry_waste` 排除正常審查往返、`agentRuns` 與 `listUsage` 一致、各 run 未回報顯示、文件措辭）。`pnpm run typecheck`、`pnpm test`（225 項）、`pnpm run build` 皆通過。

**Tech Stack:** Node.js >=22、TypeScript、Commander、Zod、Vitest、pnpm。

---

## 審查結果：`2026-09-28-run-insights.md`

計畫的核心（`retry()` 必須傳分類、分類由程式寫入、`retries.jsonl` 只 append、`insights` 是純函式）已照做且成立。以下幾處已被 0be1df5 推翻或修正，但計畫沒有同步更新：

| # | 計畫內容 | 目前實作 | 影響 |
|---|---|---|---|
| R1 | Global Constraints：「不新增 `FlowRun` 欄位」 | 新增 optional `failureCategory` | 約束已失效。理由：非 `retry()` 的失敗（仲裁停止、PR 前未結事項、agent 次數用完、例外、取消）若不記，`insights` 的失敗數和「達上限」數兜不起來 |
| R2 | 「刻意不做」：仲裁修訂、`maxAgentRuns` 用盡不記 | 仲裁修訂記為 `arbitration_revise`；`maxAgentRuns` 用盡記為 `failureCategory: agent_budget` | 同上 |
| R3 | `RetryEntry.stage` | 改名為 `backTo` | 欄位實際存的是退回的階段 |
| R4 | 13 個分類 | 14 個（多了 `arbitration_revise`） | 分類表要補 |
| R5 | `Insights.byKey`，依原始 key 加總 | `byGate`：`T1:tests` 之類的任務關卡合併成 `任務:tests` | 原設計在跨 run 時會把不相干的 T1 加在一起 |
| R6 | `listRetries` 直接 `JSON.parse` | 走 `readJsonl`，殘行略過；`addRetry` 依 `savedAt` 去重 | 原設計只要有一行殘行，`status`、`insights` 就讀不出來 |
| R7 | `missing_artifact`：缺少 `spec.md` / `plan.md` | 只有 `spec.md`；缺 `plan.md` 走 `validatePlan`，分類為 `format_invalid` | befb454 已修正文件，計畫沒改 |
| R8 | Task 2 Step 1：「計畫審查核准仍有未結事項」預期 `["plan-handoff", "open_handoff"]` | 實際在 `finishHandoff` 就擋下，是 `["plan-review-run", "handoff_invalid"]`；`open_handoff` 另由雙盲仲裁測試涵蓋 | 照計畫寫的測試會失敗 |
| R9 | Task 1：「檔尾已有未完成測試」 | 已完成 | 描述過時 |
| R10 | CLI 用 `RETRY_LABEL[...]` 加 `padEnd` | `retryLabel()`／`failureLabel()` 會處理不認得的分類，並用 `padDisplay` 依中文寬度對齊 | 照計畫實作，遇到新分類會印出 `undefined`，欄位也對不齊 |

**結論：** 這份計畫已經完成並被後續修改取代，不該再拿來當執行依據。建議在開頭加一段「已完成；後續修正見 0be1df5 與本文件」，並把 R1、R2 的理由寫進去，避免之後有人依原約束把 `failureCategory` 拿掉。

---

## 審查結果：`2026-09-28-usage-insights.md`

計畫的結構合理：
- 分組鍵集中在 `store.ts`。
- 建議是封閉代碼，門檻寫死。
- `coverage_low` 固定排第一。
- cmd 失敗的 `impactTokens` 固定為 0。
- 明確禁止在沒有重試時提早 `return`。

bd2975a 到 4b87c45 照計畫實作，但計畫本身有以下設計問題，已在未 commit 的修正中處理：

| # | 計畫內容 | 問題 | 修正後 |
|---|---|---|---|
| U1 | 「任務鍵為 `T-n`」；`byTask` 跨 run 加總；測試預期 `byTask["T-1"]` 合併兩個 run | task id 只在單一 run 內有意義。跨 run 把各 run 的第一個任務加在一起，`hot_task` 失去意義。這和 run-insights 的 R5 是同一類問題 | 移除跨 run 的 `byTask` 與「用量最高的任務」表。`hot_task` 改成逐 run 判斷（`topTaskOf`），各 run 那一列顯示「最耗任務」 |
| U2 | `byModelStage` 用 `usageKeyModelStage`，鍵是 `small / T-1-code` | 同一種步驟被 task id 拆散、不同 run 的同名任務被合併，`hot_model_step` 門檻失真 | 新增 `usageKeyModelStageKind`，鍵變成 `small / taskCode`。`status` 單一 run 仍用原鍵 |
| U3 | `mergeStats` 以 `kind:step` 為鍵 | 三個不同 run 的 `T-1-green` 各失敗一次，就會觸發「失敗 3 次」的建議 | `stepKind()` 把 `T-n-` 換成 `任務-` |
| U4 | `retry_waste`：跨 run 重試 `>= 2` | 包含 `review_changes` 與 `arbitration_revise` 這類正常流程，幾乎每個專案都會觸發，而且常排在第一則 | 排除這兩類，detail 註明「不含審查要求修改與仲裁要求修訂」 |
| U5 | 第 99 行圖示寫「只讀檔頭檔尾」；README、reference 也這樣寫 | 第 24 行自己承認 `listLogs` 會讀整份 log，互相矛盾，會讓使用者誤判速度 | 文件改成「讀整份檔案再取檔頭檔尾，run 多時會比較慢」 |
| U6 | 各 run 一律印 `N tokens` | 沒回報的 run 印出 `0 tokens`，看起來像真的用了 0 | 沒有回報時印「未回報」並對齊欄位 |
| U7 | 只把 `listUsage` 改走 `readJsonl` | `agentRuns` 仍直接數行數，殘行會多算一次 | `agentRuns` 改用 `listUsage(id).length` |

計畫本身其餘可以保留的部分：
- 第 24 行接受讀完整份 log 的代價。
- Review Focus 的各項禁止事項。
- 「刻意不做」清單。

**額外觀察（未處理，列入下方任務）：**

- O1：合併後的名稱格式不一致。任務關卡是 `任務:tests`（冒號），任務步驟是 `任務-tests`（連字號），同一個畫面上兩種寫法。
- O2：計畫把整段實作程式碼貼進 plan（1157 行）。實作後只要一修改，計畫就過時，這次 U1–U7 全部要回頭改計畫。之後的計畫改成只寫介面、門檻、測試案例名稱與預期值，程式碼留在 commit 裡。
- O3：兩份計畫與 `2026-09-28-plan-review-layers.md` 都還沒 commit，需要決定要不要進版控。

---

## 檔案職責

| 檔案 | 職責 |
|---|---|
| `docs/superpowers/plans/2026-09-28-run-insights.md` | 加上「已完成、已被取代」說明與 R1–R10 摘要 |
| `docs/superpowers/plans/2026-09-28-usage-insights.md` | 加上「已完成、已被取代」說明與 U1–U7 摘要 |
| `src/insights.ts`、`src/stats.ts` | O1：統一合併後的名稱格式 |
| `src/insights.test.ts`、`src/stats.test.ts` | 對應 O1 的預期值 |
| `docs/reference.md` | 對應 O1 的說明文字 |

---

### Task 1: commit 未提交的修正

**Files:** `README.md`、`docs/reference.md`、`src/cli.ts`、`src/stats.ts`、`src/stats.test.ts`、`src/store.ts`、`src/store.test.ts`、`src/usageInsights.ts`、`src/usageInsights.test.ts`

- [x] **Step 1: 驗證**

```bash
pnpm run typecheck
pnpm test
pnpm run build
git diff --check
```

預期：全部通過。

- [x] **Step 2: Commit**

```bash
git add README.md docs/reference.md src/cli.ts src/stats.ts src/stats.test.ts src/store.ts src/store.test.ts src/usageInsights.ts src/usageInsights.test.ts
git commit -m "$(cat <<'EOF'
insights 跨 run 不以 task id 合併用量與步驟，重試浪費排除正常審查往返。

EOF
)"
```

---

### Task 2: 統一任務合併後的名稱（O1）

**Interfaces:**
- `gateOf("T-1:tests")` 與 `stepKind("T-1-tests")` 使用同一種前綴格式。建議兩者都用 `任務:<階段>`，也就是只改 `stepKind` 的輸出，讓 `T-1-green` 變成 `任務:green`。
- 單一 run 的 `status`／`stats` 不受影響。

- [x] **Step 1: 改測試預期**：`src/stats.test.ts` 的 `mergeStats` 測試改為預期 `任務:tests`。
- [x] **Step 2: 跑測試確認失敗**：`npx vitest run src/stats.test.ts`
- [x] **Step 3: 實作**：`stepKind` 改為 `step.replace(/^T-\d+-/, "任務:")`，並把 `docs/reference.md` 的 `任務-green` 改成 `任務:green`。
- [x] **Step 4: 驗證並 commit**：`pnpm test`，commit 訊息「統一任務關卡與任務步驟合併後的名稱格式。」

---

### Task 3: 標記兩份計畫已被取代

- [x] **Step 1**：在 `2026-09-28-run-insights.md` 的 Goal 前加上：

  > **狀態：已完成（d54f5ad–befb454），部分約束已被 0be1df5 推翻。** 以程式與 `docs/reference.md` 為準。差異見 `2026-09-28-insights-plan-review.md` 的 R1–R10，特別是新增 `FlowRun.failureCategory` 與 `arbitration_revise` 的理由。

- [x] **Step 2**：在 `2026-09-28-usage-insights.md` 的 Goal 前加上：

  > **狀態：已完成（bd2975a–4b87c45），跨 run 分組已依 `2026-09-28-insights-plan-review.md` 的 U1–U7 修正。** 內文的 `byTask`、`small / T-1-code`、`T-1-tests` 等跨 run 預期值已不適用。

- [x] **Step 3**：決定 O3，也就是三份計畫要不要 commit。若要 commit，與本文件一起提交：

```bash
git add docs/superpowers/plans/2026-09-28-*.md
git commit -m "新增 insights 相關計畫與審查紀錄。"
```

---

## 刻意不做

- 不把計畫內嵌的舊程式碼逐段改成新版。計畫已完成，只標記取代並列出差異。
- 不改變 `status <id>`／`stats <id>` 的單一 run 分組。task id 在單一 run 內有意義。
- 不為 `listLogs` 做只讀首末行的優化（沿用 usage-insights 計畫的取捨，文件已照實說明代價）。
