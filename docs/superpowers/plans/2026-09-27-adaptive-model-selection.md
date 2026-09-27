# Adaptive Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者透過 CLI 登記並驗證各 agent 模型，再依階段、任務難度與重試情形自動選模，保留既有角色分工。

**Architecture:** 設定與選模放在獨立模組；engine 只在每次 LLM 呼叫前取得所選模型。模型探測使用 adapter 專用的無工具呼叫。用量紀錄保留模型名稱與回報狀態，舊資料標為未知。

**Tech Stack:** Node.js 22+、TypeScript、Commander、Zod、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-27-adaptive-model-selection-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者輸出使用繁體中文。
- 修改使用者可見行為時，同一個 commit 更新 README；完整規則放入 `docs/reference.md`。
- 新 `FlowRun` 欄位設為 optional，舊 run 可 resume。
- 角色及關卡仍由現有程式規則決定。

## Review Focus

- CLI 模型名稱無效或探測逾時時，不能寫入設定。
- `command` 探測輸出與輸入模型不符時，不能宣稱已驗證。
- 審查小組後一位失敗時，前一位不應升級模型。
- 舊用量 0 token 不能與明確回報的 0 混淆。
- `balanced` 與舊 run 應維持原有模型選擇。

---

### Task 1: 設定、任務難度與純選模

**Files:** `src/schemas.ts`, `src/modelSelection.ts`, `src/modelSelection.test.ts`, `src/schemas.test.ts`, `src/engine.ts`, `prompts/plan.md`, `prompts/plan-review.md`, `prompts/plan-fix.md`。

**Interfaces:** `selectModel(run, cfg, agent, step, complexity?, reviewer?)` 回傳名稱、目標強度與實際設定強度；`validateAdaptiveConfig(cfg, cycle)` 在 run 建立前檢查設定。

- [ ] 寫 schema、預設強度、選模與舊格式測試，確認測試因缺功能失敗。
- [ ] 實作 `models`、`modelSelection`、`TaskItem.complexity`、可選 run 欄位及純選模函式，跑測試。
- [ ] 更新計畫 prompt 與計畫驗證：adaptive 必填難度，balanced 可省略，排序檔保留難度；跑測試。

### Task 2: 模型事件、執行輸出與用量

**Files:** `src/agents/*.ts`, `src/agents/adapters.test.ts`, `src/runner.ts`, `src/runner.test.ts`, `src/store.ts`, `src/store.test.ts`, `src/logs.ts`, `src/cli.ts`。

**Interfaces:** `runAgent` 接收選定模型並回傳 `resolvedModel`、`usageReported`；用量資料可按模型與步驟統計。

- [ ] 寫模型參數、事件解析、用量 0／未知及舊紀錄測試，確認失敗。
- [ ] 實作事件、終端顯示、log／用量欄位、status 統計與 `command` 占位符；跑測試。

### Task 3: 模型管理指令與安全探測

**Files:** `src/modelConfig.ts`, `src/modelConfig.test.ts`, `src/modelProbe.ts`, `src/modelProbe.test.ts`, `src/agents/*.ts`, `src/proc.ts`, `src/agentConfig.ts`, `src/cli.ts`。

**Interfaces:** `model add/set/remove/list/check/mode/stage` 管理設定；`probeModel` 回傳驗證結果，無法安全停用工具時拒絕。

- [ ] 寫設定變更、探測成功／失敗／逾時與 command 契約測試，確認失敗。
- [ ] 實作專用探測與逾時、設定編輯與 CLI 指令，跑測試。

### Task 4: Engine 串接與重試

**Files:** `src/engine.ts`, `src/engine.test.ts`, `src/cli.ts`, `src/roles.test.ts`。

**Interfaces:** 每次 `agentStep` 呼叫前依實際 agent 選模；`modelRetryAttempts` 只影響失敗的審查者，共用 `attempts` 保留上限。

- [ ] 寫多階段選模、代打、個別審查升級及 attempts 清理的失敗測試。
- [ ] 實作 engine 串接、run mode 保存、resume 相容及重試計數；跑測試。

### Task 5: 文件與完整驗證

**Files:** `README.md`, `docs/reference.md`, 前述測試。

- [ ] 將入門指令與最小設定寫入 README，完整欄位、路由與限制寫入 reference。
- [ ] 執行 `pnpm run typecheck`、`pnpm test`、`pnpm run build`，檢查 `git diff --check`。
- [ ] 審閱整份差異，修正高風險問題後提交。
