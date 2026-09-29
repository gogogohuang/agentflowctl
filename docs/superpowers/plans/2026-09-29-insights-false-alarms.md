# insights 誤報修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `stats` 與 `insights` 不再把「紅燈測試按預期失敗」當成失敗步驟，也不再把「幾乎全是 cache 讀取」的輸入誤判為「上下文太大」。

**Architecture:** 兩處都是純函式的判斷修正，不動 log 格式與 store：`stats.ts` 的 `computeStats` 對 `T-<n>-red` 這個專案指令反轉失敗判定（測試意外通過才算失敗，對應 `tests_not_red` 重試）；`usageInsights.ts` 的 `input_heavy` 改以「不含 cache 讀取的輸入」計算，並在說明中另列 cache 讀取量。

**Tech Stack:** TypeScript、vitest。

**Spec:** 無獨立 spec。動機見對話中的花費分析：`f-mulcedrq` 的 `insights` 出現「任務:red 失敗 7 / 7」與「輸入佔 99.1%」兩則誤導的建議。

## Global Constraints

- 程式碼、註解、輸出都用繁體中文。
- 使用者看得到的行為有變動，同一個 commit 要更新 `README.md`。
- 不改 `FindingCodes`、不改既有 `FINDING_LABEL` 文字（測試 `usageInsights.test.ts:85` 鎖定了 `hot_failing_step` 的標題）。
- 不動 log 檔頭檔尾格式（`logs.ts`）與 `runCommand` 的 `ok` 語意（`ok = 結束碼為 0`）。
- 舊 run 的 log 也要能得到修正後的結果：判定只看步驟名稱與檔尾 `ok`，不需要新欄位。

## File Structure

- Modify: `src/stats.ts`：`computeStats` 的失敗判定。
- Modify: `src/stats.test.ts`：既有測試裡的 `T-1-red` 成功案例語意改變，需要更新並新增案例。
- Modify: `src/usageInsights.ts`：`input_heavy` 的門檻與說明。
- Modify: `src/usageInsights.test.ts`：新增案例。
- Modify: `README.md`：`stats`／`insights` 的失敗定義與 `input_heavy` 說明。

---

### Task 1: 紅燈步驟的失敗判定反轉

**Files:**
- Modify: `src/stats.ts:34-60`
- Test: `src/stats.test.ts`
- Modify: `README.md`（同步說明紅燈失敗定義）

**Interfaces:**
- Consumes: `LogEntry`（`logs.ts`），`footer.ok` 為結束碼是否為 0。
- Produces: `computeStats` 的 `StepStat.failed` 對 `kind === "cmd"` 且步驟名稱符合 `/^T-\d+-red$/` 者，改為「`footer.ok === true` 的次數」（測試在功能未實作前就通過）。其他步驟不變。`mergeStats` 只做加總，不需修改。

- [ ] **Step 1: 寫失敗的測試**

在 `src/stats.test.ts` 的 `describe("computeStats", ...)` 內加：

```ts
  it("紅燈指令失敗是預期結果，測試意外通過才算失敗", () => {
    const { steps } = computeStats([
      entry("T-1-red", "cmd", "00:00", "00:10", false),
      entry("T-1-red", "cmd", "01:00", "01:10", false),
      entry("T-1-red", "cmd", "02:00", "02:10", true),
      entry("T-1-green", "cmd", "03:00", "03:10", false),
    ]);
    expect(steps.find((s) => s.step === "T-1-red")).toMatchObject({ runs: 3, failed: 1 });
    expect(steps.find((s) => s.step === "T-1-green")).toMatchObject({ runs: 1, failed: 1 });
  });

  it("agent 步驟即使名稱含 red 也照一般規則", () => {
    const { steps } = computeStats([entry("T-1-red", "claude", "00:00", "00:10", false)]);
    expect(steps[0]).toMatchObject({ kind: "agent", failed: 1 });
  });
```

並修正既有第一個測試：它的 `entry("T-1-red", "cmd", ..., )` 兩筆都是 `ok = true`，在新語意下 `failed` 會變成 2。把那兩筆改成 `entry("T-1-red", "cmd", "02:00", "02:10", false)`、`entry("T-1-red", "cmd", "07:00", "07:20", false)`，預期的 `T-1-red` 仍是 `failed: 0`。

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/stats.test.ts`
Expected: 新測試 FAIL（`T-1-red` 的 `failed` 現在是 2，不是 1）。

- [ ] **Step 3: 實作**

在 `src/stats.ts` `computeStats` 之前加：

```ts
/** 紅燈階段的測試指令：失敗才是預期結果，意外通過才代表這一步沒過關 */
const isRedCommand = (kind: StepStat["kind"], step: string) => kind === "cmd" && /^T-\d+-red$/.test(step);
```

把 `if (!footer.ok) s.failed += 1;` 改成：

```ts
    if (isRedCommand(kind, header.step) ? footer.ok : !footer.ok) s.failed += 1;
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npx vitest run src/stats.test.ts && pnpm run typecheck`
Expected: PASS。

- [ ] **Step 5: 確認 insights 端不需另外改**

Run: `npx vitest run src/usageInsights.test.ts src/insights.test.ts`
Expected: PASS。`hot_failing_step` 使用 `StepStat.failed`，會自動反映新語意。

- [ ] **Step 6: Commit**

```bash
git add src/stats.ts src/stats.test.ts README.md
git commit -m "stats：紅燈測試指令失敗是預期結果，意外通過才算失敗"
```

---

### Task 2: input_heavy 不計入 cache 讀取

**Files:**
- Modify: `src/usageInsights.ts:125-131`
- Test: `src/usageInsights.test.ts`
- Modify: `README.md`（同步說明 `input_heavy` 不含 cache 讀取）

**Interfaces:**
- Consumes: `UsageSummary`（`store.ts`）：`inputTokens` 已含 cache 讀寫；`cacheReadTokens`、`cacheWriteTokens` 是其中一部分；`outputTokens`。
- Produces: `usageFindings` 的 `input_heavy` 改為：`freshInput = total.inputTokens - total.cacheReadTokens`，`freshTotal = freshInput + total.outputTokens`；`freshInput / freshTotal >= 0.85` 且 `freshTotal >= 5000` 時觸發，避免大量 cache 讀取單獨把樣本撐過最小量體門檻。`impactTokens` 為 `freshInput`。

- [ ] **Step 1: 寫失敗的測試**

在 `usageFindings` 的 `describe` 內、沿用 `codes` 與 `summary` 輔助函式加：

```ts
    // 輸入幾乎全是 cache 讀取：不算輸入太大
    expect(codes({
      total: summary({ tokens: 10000, inputTokens: 9500, outputTokens: 500, cacheReadTokens: 9000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("input_heavy");
```

再加一個比例雖達門檻、但非 cache 總量不足的反例：

```ts
    expect(codes({
      total: summary({ tokens: 10000, inputTokens: 9850, outputTokens: 150, cacheReadTokens: 9000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    })).not.toContain("input_heavy");
```

這筆資料的 `freshInput` 是 850、輸出是 150，fresh input 比例為 85%，但非 cache 總量只有 1000，不應產生高影響建議。

再加一個檢查說明文字的案例：

```ts
    const heavy = usageFindings({
      total: summary({ tokens: 10000, inputTokens: 9500, outputTokens: 500, cacheReadTokens: 2000, runs: 5, reportedRuns: 5 }),
      byStrength: {},
      byStage: {},
      retries: [],
      substitutions: 0,
    }).find((f) => f.code === "input_heavy");
    expect(heavy?.impactTokens).toBe(7500);
    expect(heavy?.detail).toContain("不含 cache 讀取的輸入 7500");
    expect(heavy?.detail).toContain("另有 cache 讀取 2000 未計入");
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npx vitest run src/usageInsights.test.ts -t "usageFindings"`
Expected: FAIL（現行邏輯會觸發第一個案例，且說明沒有「不含 cache 讀取」）。

- [ ] **Step 3: 實作**

把 `input_heavy` 區塊改為：

```ts
  const freshInput = total.inputTokens - total.cacheReadTokens;
  const freshTotal = freshInput + total.outputTokens;
  if (freshTotal >= 5000 && freshInput / freshTotal >= 0.85) {
    out.push({
      code: "input_heavy", impactTokens: freshInput, title: FINDING_LABEL.input_heavy,
      detail: `不含 cache 讀取的輸入 ${freshInput}、輸出 ${total.outputTokens}（輸入佔 ${pct(freshInput, freshTotal)}）；另有 cache 讀取 ${total.cacheReadTokens} 未計入。上下文可能太大：規格、計畫、測試輸出或一次讀太多檔。`,
    });
  }
```

`freshTotal` 為 0 時不會進到除法，因為前面先要求 `freshTotal >= 5000`。

- [ ] **Step 4: 執行測試確認通過**

Run: `pnpm test && pnpm run typecheck`
Expected: 全過。若既有案例（例如 `usageInsights.test.ts:96` 的 `inputTokens: 19000, cacheReadTokens: 100`）的排序斷言因 `impactTokens` 由 19000 變成 18900 而改變，依實際輸出調整預期並確認合理。

- [ ] **Step 5: Commit**

```bash
git add src/usageInsights.ts src/usageInsights.test.ts README.md
git commit -m "insights：input_heavy 不計入 cache 讀取，說明另列 cache 讀取量"
```

---

### Task 3: 文件確認

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 找出現有說明**

Run: `grep -n "失敗次數\|input_heavy\|輸入遠大於輸出\|stats" README.md | head -20`

- [ ] **Step 2: 在對應行為 commit 補上說明**

- 在 `stats` 的說明加一句：「紅燈階段的測試指令（`T-<n>-red`）失敗是預期結果，只有測試意外通過才計為失敗。」
- 在 `insights` 建議規則的說明加一句：「『輸入遠大於輸出』不計入 cache 讀取（Claude 的 cache 寫入仍計入），門檻是非 cache 的輸入與輸出合計至少 5000 tokens 且輸入佔 85% 以上；cache 讀取量另外列在說明中。」

- [ ] **Step 3: 全部檢查**

Run: `pnpm run typecheck && pnpm test`
Expected: 全過。

- [ ] **Step 4: 確認 commit 邊界**

不要建立獨立文件 commit：紅燈失敗定義應隨 Task 1 的 commit 提交，`input_heavy` 說明應隨 Task 2 的 commit 提交。確認兩個 Task 的 commit 指令都已包含 `README.md`。

---

## Self-Review

- **Coverage：** 兩個誤報各有一個 Task；README 有 Task 3；`stopReport` 的相關影響已評估並列入「刻意不做」。
- **Placeholder：** 無；Task 2 Step 4 已註明既有排序斷言可能需依實際輸出微調（數值 19000→18900 不會改變相對順序，但保留確認步驟）。
- **型別一致：** `isRedCommand(kind, step)` 只在 `stats.ts` 使用；`freshInput` 只在 `usageFindings` 內。

## 刻意不做

- **重試成本估算改用真實 tokens**（原本想做）：`retries.jsonl` 的 key（如 `T-1:fix`、`plan-review-run`）與 `costs.jsonl` 的 stage（如 `T-1-fix`）命名不一致，且一次重試可能對應多次呼叫，硬對應容易算錯。目前「平均每次」的估算維持不變，說明文字已標示為估算。
- **`stopReport.ts` 的「最後失敗的步驟」**：`stopReport` 以 `footer.ok === false` 找最後一個失敗的 log（`stopReport.ts:48`），只在 run 為 `failed` 時用來決定顯示哪一步。紅燈指令按預期失敗後，若 run 之後因別的原因失敗、且中間沒有其他失敗的 log，停止報告可能顯示那次紅燈指令。這只影響停下時先顯示哪份 log，而且要改就得在 `stopReport` 複製同一條紅燈規則；本計畫先不動。若要修，把 `isRedCommand` 移到 `logs.ts` 匯出，讓 `stats.ts` 與 `stopReport.ts` 共用，另案處理。
- **依價格加權的「等值成本」**：各家 CLI 的 cache 計價不同，寫死係數會誤導；只做「不計入 cache 讀取」這個保守修正。
