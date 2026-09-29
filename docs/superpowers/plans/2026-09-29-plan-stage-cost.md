# 計畫階段成本（審查來回）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低 plan → plan_review → plan_fix 這一段的 token 花費（`f-mulcedrq` 這段約 1,740 萬，占三成；`plan-review` 被要求修改 4 次、22 次呼叫全用 high 強度），做法是先用資料確認審查在挑什麼，再把「程式就能查」的問題提前到 plan 階段擋掉。

**Architecture:** 三步走：(1) 先診斷：從真實 run 的審查意見分類，決定值不值得做後面的事，不憑猜測改；(2) 把 `planReview.ts` 裡能明確判錯的 `missingTaskHeadings` 提前成 `validatePlan` 關卡，讓 plan 與 plan_fix 階段自己被退回，而不是等 high 強度的審查者浪費一次呼叫；`extractFiles` 抽不到路徑時現行分群仍有相依與 loose-task 容錯，不把最佳化訊號直接升級成格式錯誤；(3) 文件說明現成的 `modelSelection.stageStrength.planReview` 調整與量測方式。

**Tech Stack:** TypeScript、vitest。

**Spec:** 無獨立 spec。動機見對話中的花費分析；相關既有設計見 `docs/superpowers/plans/2026-09-28-plan-review-layers.md`。

## Global Constraints

- 程式碼、註解、輸出都用繁體中文。
- 使用者看得到的行為有變動，同一個 commit 要更新 `README.md`。
- 關卡判斷只看程式能檢查的事實；不新增依賴 agent 自述的判斷。
- 新增的檢查放在 `validatePlan`，沿用兩個呼叫端既有的失敗處理：plan 階段走 `retry(run, "plan", ..., "plan", "format_invalid")`；plan_fix 階段（`engine.ts:643`）先 `restorePlan` 還原修訂，再走 `retry(run, "plan-fix", ..., "plan_fix", "format_invalid")`。不新增 `RetryCategory`、不新增 run 狀態欄位。
- 不改預設模型強度（`DEFAULT_STAGE_STRENGTH`）：降強度會影響審查品質，要先有 Task 1 的資料。

## File Structure

- Modify: `docs/superpowers/plans/2026-09-29-plan-stage-cost.md`（本檔）：Task 1 把診斷結果寫回「診斷結果」一節。
- Modify: `src/engine.ts:282-294`（`validatePlan`）：加任務標題的確定性檢查。
- Modify: `src/engine.test.ts`：plan、plan_fix 各一個新測試，以及被新關卡擋下的既有夾具。
- Modify: `README.md`、`docs/reference.md`：說明新關卡與 `planReview` 強度調整。

---

### Task 1: 診斷——審查在挑什麼（不改程式碼）

**Files:**
- Modify: 本檔最後的「診斷結果」一節

在 `f-mulcedrq` 所在的專案（`taxigo_console`，工作目錄 `.agentflowctl/runs/f-mulcedrq/`）操作。這個任務不需要本 repo 的程式碼變更，產出是一張分類表，作為 Task 2、3 是否值得做的依據。

- [ ] **Step 1: 取得 4 次 plan-review 要求修改的內容**

Run（在 taxigo_console 專案根目錄）：

```bash
cat .agentflowctl/runs/f-mulcedrq/retries.jsonl | grep plan-review
ls .agentflowctl/runs/f-mulcedrq/reviews/
npx agentflowctl@latest logs f-mulcedrq | head -80
```

Expected: 列出每一輪的重試原因與審查意見檔。

- [ ] **Step 2: 逐條意見分類**

用兩個互相獨立的維度記錄每條意見，避免「結構問題重複出現」被迫只能算 A 或 C，導致後續決策相反。

第一個維度是問題性質，每條只能分到其中一類：

| 類別 | 例子 | 程式能不能提前查 |
|---|---|---|
| A 結構問題 | task 缺 `## T-n` 標題、description 沒有帶目錄的路徑、AC 沒對應 | 能 |
| B 內容問題 | 任務拆錯、相依順序不合理、漏掉邊界情況 | 不能 |
| D 新的挑剔 | 前幾輪沒提過、且不影響實作的意見 | 不能 |

第二個維度是是否重複：若同一實質問題連續出現在兩輪以上，另外標記 `repeated: true`。記錄重複數量與例子，但不要從 A／B／D 的性質統計中移除。

- [ ] **Step 3: 確認分層審查是否生效**

Run: `grep -n "這次計畫審查讀整份計畫" .agentflowctl/runs/f-mulcedrq/logs/* 2>/dev/null; npx agentflowctl@latest status f-mulcedrq | head -30`

Expected: 若有輸出「這次計畫審查讀整份計畫：<原因>」，記下原因，代表分層被略過、每輪都用 high 強度讀整份計畫。

- [ ] **Step 4: 寫下診斷結果並決定**

在本檔最後的「診斷結果」一節填入分類表與分層狀態，並依下面規則決定後續。比例一律以「意見條數」為分母（一輪有多條意見就算多條），「多數」指 ≥ 50%：
- A 類 ≥ 50%，或任何一輪分層因「缺 `## T-n` 標題」被略過 → 做 Task 2。
- `repeated: true` ≥ 50% → 另開 plan-fix prompt 計畫；這不取消已由 A 類或缺標題條件獨立支持的 Task 2。
- D 類 ≥ 50% → 考慮 Task 3 的降強度，並在 `plan-review.md` 的 `<review_focus>` 加上「只提會影響實作結果的問題」（另案）。
- 都未達門檻 → 不做 Task 2，只做 Task 3 的 Step 2（強度調整與量測說明），並在診斷結果寫明理由。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-29-plan-stage-cost.md
git commit -m "計畫階段成本：記錄真實 run 的審查意見分類"
```

---

### Task 2: 把任務標題檢查提前到計畫定稿與修訂（僅在 Task 1 判定支持時做）

**Files:**
- Modify: `src/engine.ts:282-294`（`validatePlan`）
- Test: `src/engine.test.ts`
- Modify: `README.md`、`docs/reference.md`（同步說明新關卡）

**Interfaces:**
- Consumes: `missingTaskHeadings(planMd: string, taskIds: string[]): string[]`（`planReview.ts`）。
- Produces: `validatePlan` 在任務缺少標題時回傳可直接回饋給 agent 的錯誤字串。`validatePlan` 有兩個呼叫端：`planStage`（`engine.ts:333`）與 `planFixStage`（`engine.ts:643`），兩者都會受影響。

- [ ] **Step 1: 寫失敗的測試**

`src/engine.test.ts` 加一個 `describe("缺少任務標題", ...)`，內含兩個案例（仿現有 plan／plan_fix 測試的夾具，用 `maxAgentRuns: 1` 在一次 agent 呼叫後截斷）：

1. plan 階段：agent 寫出 plan.md 缺少 `## T-2` 標題，run 應以 `format_invalid` 重試並回到 `plan`，而不是進入 `plan_review`。

```ts
expect(run).toMatchObject({ failedStage: "plan", failureCategory: "agent_budget" });
expect(listRetries(run.id).map((r) => [r.key, r.category])).toContainEqual(["plan", "format_invalid"]);
expect(readFileSync(join(flowDir(run.id), "feedback.md"), "utf8")).toContain("T-2");
```

2. plan_fix 階段：起始 plan.md 每個任務都有標題，agent 修訂時刪掉 `## T-2`，run 應以 `plan-fix` 鍵的 `format_invalid` 重試，且 plan.md 還原成修訂前的內容。

```ts
expect(run).toMatchObject({ failedStage: "plan_fix", failureCategory: "agent_budget" });
expect(listRetries(run.id).map((r) => [r.key, r.category])).toContainEqual(["plan-fix", "format_invalid"]);
expect(readFileSync(join(flowDir(run.id), "plan.md"), "utf8")).toBe(planBefore);
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/engine.test.ts -t "缺少任務標題"`
Expected: 兩個都 FAIL（plan 案例會進入 plan_review；plan_fix 案例會接受修訂）。

- [ ] **Step 3: 列出會被新關卡擋下的既有夾具**

Run: `grep -n "plan.md" src/*.test.ts | grep -v "## T-"`

逐一確認每個命中處是否會經過 `planStage` 或 `planFixStage`（例如起始 `stage` 為 `plan`／`plan_fix`，或從 `plan_review` 被要求修改後進入 `plan_fix`，且 agent 會成功寫出計畫）。已知候選：`engine.test.ts:165、207、273` 的 `"# 計畫\n"`，以及 `engine.test.ts:890-990` 一帶起始於 `plan_fix` 的案例。把確定受影響的測試名稱記在這一步的 checkbox 下，Step 5 逐一補上 `## T-n` 標題。

注意 `engine.test.ts:739`「plan.md 缺任務標題時改走整份審查」是刻意沒有標題的夾具，它驗證的是 plan_review 的降級行為：若它只停在 plan_review，保留原樣；若它會進入 plan_fix，只讓 plan_fix 的 fake agent 寫出有標題的計畫，不要改掉起始的無標題 plan.md。

- [ ] **Step 4: 實作**

`src/engine.ts` 的 `validatePlan` 在 `orderTasks` 之前、`complexityError` 之後加（`TASK_HEADING` 接受 `##` 到 `######`，錯誤訊息以 `##` 為代表，和 `planReview.ts` 既有的降級訊息一致）：

```ts
  const planMd = readFileSync(flowFile(run, "plan.md"), "utf8");
  const noHeading = missingTaskHeadings(planMd, tasks.data.map((t) => t.id));
  if (noHeading.length) return `plan.md 缺少 ${noHeading.join("、")} 的「## T-<數字>」標題；每個任務都要有自己的一節，並在其下列出難度證據`;
```

並在 `engine.ts` 開頭 import 補上 `missingTaskHeadings`（`planReview.js` 已有 `layeredReview` 的 import，加在同一處）。`plan.md` 是否存在已由函式開頭檢查。

不要把 `extractFiles(task.description).length === 0` 當成格式錯誤：現行 `taskClusters` 會把無法抽取路徑的任務依 `dependsOn` 併群，或把 loose tasks 集中處理；而且 `extractFiles` 不辨識 `Dockerfile` 等無副檔名路徑。若 Task 1 顯示缺路徑確實是主要問題，另開計畫先定義完整的路徑格式與相容策略。

- [ ] **Step 5: 執行測試確認通過**

Run: `pnpm test && pnpm run typecheck`
Expected: 全過。Step 3 列出的夾具都已補上 `## T-n` 標題（它們本來就不符合 `plan.md` prompt 的要求）；只補標題，不補路徑，因為本計畫不檢查路徑。

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts src/engine.test.ts README.md docs/reference.md
git commit -m "計畫定稿與修訂時檢查任務標題，不合格直接退回不進審查"
```

---

### Task 3: 文件——階段強度調整與量測

**Files:**
- Modify: `README.md`、`docs/reference.md`

- [ ] **Step 1: 補上 Task 2 的關卡說明**（若做了 Task 2）

在描述 plan 階段檢查的位置加：「計畫定稿與修訂時，程式會檢查每個任務在 `plan.md` 都有 `## T-<數字>` 標題；plan 階段不合格直接退回重寫，不進計畫審查；plan_fix 階段不合格則還原這次修訂並重試。」這段必須併入 Task 2 的行為 commit，不留到獨立文件 commit。

- [ ] **Step 2: 補上強度調整與量測說明**

在 `modelSelection` 說明附近加一個範例與量測方式：

```json
{ "modelSelection": { "mode": "adaptive", "stageStrength": { "planReview": "medium" } } }
```

並註明：`planReview` 預設是 `high`；調低前後各跑一個相近大小的需求，用 `agentflowctl insights` 比較 `planReview` 的呼叫數、用量與 `plan-review` 的重試次數，再決定要不要維持。不要只看單次 token。

- [ ] **Step 3: 全部檢查**

Run: `pnpm run typecheck && pnpm test`
Expected: 全過。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/reference.md
git commit -m "說明計畫階段的結構檢查與 planReview 強度調整"
```

此 commit 只提交 `planReview` 強度調整與量測說明；Task 2 的新關卡說明已隨行為 commit 提交。

---

## Self-Review

- **Coverage：** 診斷（Task 1，含明確門檻）、提前擋結構問題（Task 2，涵蓋 `validatePlan` 的兩個呼叫端 plan 與 plan_fix）、文件與量測（Task 3）。
- **Placeholder：** Task 1 的產出需要在執行時填入，因為資料在使用者另一個專案；這是資料蒐集而非待補的設計，其決策規則已寫死。
- **型別一致：** `missingTaskHeadings` 簽章沿用 `planReview.ts` 現有介面，不新增任務路徑驗證介面。

## 刻意不做

- **直接降低 `planReview` 預設強度**：沒有品質資料前不改預設；提供設定與量測方式讓使用者自己 A/B。
- **依輪次自動降級**（第 1 輪 high、之後 medium）：要在 `selectModel` 加輪次概念，牽動 `modelSelection`、`schemas`、README；等 Task 1 證實後續輪次只是在驗證修正，再另案。
- **改 plan／plan-fix prompt**：Task 1 若顯示 `repeated: true` 占多數，才有明確的改法，屆時另開計畫。

## 診斷結果

（Task 1 完成後填寫：分類表、分層是否生效及原因、決定做哪些後續。）
