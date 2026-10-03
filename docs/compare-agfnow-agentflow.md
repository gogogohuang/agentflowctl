# 與 agfnow/agentflow 的流程設計比較

比較對象：https://github.com/agfnow/agentflow（v8.4.9，2026-10-03 讀取）。

依據：該 repo 的 README、`SKILL.md`、`references/ag.md`、`delegation.md`、`looper.md` 與 acceptance advisor。只讀文件，沒有跑它的程式碼，也沒有逐檔讀 `scripts/`；「靠 prompt 規範」這個判斷主要根據文件。

## 本質差異

| | agentflowctl（本 repo） | agfnow/agentflow |
|---|---|---|
| 形態 | Node CLI，狀態機由程式推進 | Claude／Codex 的 skill 加 plugin，由對話中的 host agent 推進 |
| 誰決定流程 | `engine.ts` 的 `STAGES` 寫死 | host agent 讀 markdown 規則，自己選 route：`direct`、`selected_advisors`、`full_pipeline`、`blocked` |
| 狀態與交接 | `state.json` 加 `.flow/*.json`，zod 驗證 | 人讀的 devlog notebook，加 `tracker.md`、`ag.json`、帶時間戳與 `Self-check:` 的 artifact |
| 關卡 | 測試、git diff、schema，不看 agent 自述 | 也強調 coordinator 親自驗證，但執行者是 LLM，靠 prompt 規範，腳本只做 linter 與 gate |
| 主要目標 | 無人值守做完到開 PR | 跨 session 保留對話與決策，流程可大可小 |

共同點：worker 說完成不算數，由協調者驗證。我們的協調者是程式，它的協調者是 LLM。

## 對方有、我們沒有的設計

1. **依任務複雜度分流。** 有 `direct`／`fast-lane`／`full_pipeline` 三條路，用五個固定的 `complexity_reasons`（`material_uncertainty`、`cross_subsystem_coordination`、`public_or_stored_data_contract`、`trust_boundary`、`unresolved_material_decision`）判斷，不看工作長度。我們每個 run 都走完整 spec → plan → … → pr，小改動成本偏高。
2. **前置的需求與探索階段。** 完整流程是 requirements → codewalk → explore／spike → spec → implement → security-scan → acceptance → learn，每個階段有簽核關卡與 `R-n`／`INV-n` 編號。acceptance 逐條回報 `R-n` 是 covered、missing 還是 not proven，並檢查不變式。我們的 `acceptance.json` 沒有編號覆蓋表。
3. **Minimality 檢查。** acceptance 會獨立嘗試刪減、合併或重用既有行為；更小的設計也能滿足需求就 BLOCKING。我們的審查沒有這一項。
4. **Worker finding 不自動成為需求。** coordinator 必須引用 owner 原話或既有義務，才能把審查發現轉成修正，否則拒絕或擱置。我們的 review ⇄ fix 迴圈直接採納審查者意見，有範圍膨脹的風險。
5. **security-scan 獨立階段。** 我們只有一般 review。
6. **模型分級。** `best`／`better`／`basic`／`cheap` 依階段挑模型（安全審查用 best，實作用 basic）。我們依 agent 家別輪替，沒有依階段分級。
7. **事故紀錄。** `incidents-log.md`，規則以 `— I-NNN` 標記，修改前必須先讀事故敘述。我們沒有「規則連結失敗案例」的機制。
8. **owner 控制詞。** `skip-ag`、`no-ag`、`cross-check`、`3ways`、`skip-review` 讓使用者在單次請求調整流程。我們的控制在 `flow.config.json` 和 CLI 參數。

## 我們有、對方沒有的設計

1. **確定性狀態機。** 每步原子存檔，可中斷後 `resume`。它的 recovery 靠 notebook 加 hook，弱得多。
2. **TDD 紅綠分離。** 測試與實作由不同家 agent 負責（`tddSplit`），並有 `packageExports` 靜態檢查。它只要求 worker「red-first」，沒有程式強制。
3. **平行車道。** 獨立 worktree、合併與衝突重做。它一次只跑一個 plan。
4. **平行審查加仲裁。** `executeReviewCalls` 平行審查，計畫僵持時仲裁。它只有單一 reviewer（三次上限）加 `3ways` 辯論。
5. **額度處理。** `QuotaPause`、代打與 `substitutions.jsonl`。它只在 profile 被 session limit 停用時換另一個。
6. **用量與失敗統計。** `insights`、`usageInsights`。

## 可借鏡的方向（依優先順序）

1. **輕量路徑。** 加一條小改動路徑（例如 `--fast`），跳過 plan_review 與仲裁，只保留 implement → verify → pr。成本小、效益最高。
2. **審查發現須可追溯。** review 的 finding 要對應到規格或驗收條件的編號，對不上就不進 fix。約束 review ⇄ fix 的範圍膨脹，符合「關卡看事實」的原則。
3. **驗收編號覆蓋表。** `acceptance.json` 條目加穩定 ID，最終 review 逐條回報 covered／missing／not proven，由程式檢查每條都有回報。可做成純程式關卡。
4. **Minimality 審查項。** 在 review prompt 加一段「嘗試刪減或重用既有行為」，成本低。
5. **security-scan 選配階段。** 觸碰信任邊界或使用者要求時才跑。

## 不建議借鏡

- 讓 LLM 自己決定 route 與流程：違背由程式推進的核心。
- 以 notebook 為主要狀態：`state.json` 加 zod 已經更可靠。
- 人工簽核每個階段：我們定位是無人值守，已有等待核准可選。
