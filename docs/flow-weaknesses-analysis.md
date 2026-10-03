# 流程缺點與缺陷分析

分析日期：2026-10-03，基準 commit：`2ded641`（0.27.0）。

## 處理進度

A 類已在 PR #65（分支 `fix/review-gates`）處理，B 到 F 類尚未動。各項的細節在下面對應章節的「修改結果」。

| 項目 | 狀態 |
|---|---|
| A1 審查覆蓋表 | 已修：`reviewCoverage.ts`，審查 prompt 改為逐條回報 |
| A2 額外發現分類 | 已修：需附 evidence、與驗收條件分開標示、只在第一次審查能擋關 |
| A3 繞過檢查 | 已修：修正階段偵測 skip／only／todo、抑制註解、斷言減少；綠燈階段偵測抑制註解。沒有測試框架時綠燈仍直接視為通過，未處理 |
| A4 非 TDD 任務略過 | **不強制審查**（沒有變更常是合理的，例如設定、文件、行為已存在）。改為略過時在交接帳本留 `info`，由 A1 的整體審查覆蓋表核對該任務的驗收條件 |
| A5 範圍守衛 | 已修：認得目錄與根目錄檔案；守衛達次數上限放行時印警告。沒有任何任務提到的檔案仍不受限，這是刻意保留 |
| A6 仲裁分歧 | 已修：不改預設值，沒核准的意見記成程式碼類 `action`，最終審查必須結案 |
| A7 reviewQuorum 預設 1 | 只補文件警語，**沒有改預設值**（改成 2 會讓每次審查成本加倍，需要你決定） |

驗證：`pnpm run typecheck`、`pnpm test`（636 個）、`pnpm run build` 在本機通過。PR 推送後的 CI 結果沒有記在這裡。

## 範圍與方法

- 讀過的程式碼：`engine.ts` 的 `agentStep`、`retry`／`succeed`、`planSettled`、`validatePlan`、`arbitratePlan`、`implementStage`（紅綠燈）、車道（`prepareLane`／`driveLane`／`mergeLane`／`implementLanes`）、任務審查／驗證／修正、`runChecks`、`verifyStage`、`applyFix`、`codeReview`、`reviewStage`、`prStage`、`advance`；`tasks.ts`、`lanes.ts`、`git.ts` 的 `mergeBranch`、`schemas.ts` 的審查與計畫 schema、`cli.ts` 的 `run`／`approve`／`replan`／`iterate`／`resume`／`cancel`；`prompts/review.md`、`fix.md`、`task-review.md`。
- 沒有細讀：`planFixStage`、`planReviewLayered`、`parallelReview.ts`、`tempWorktree.ts`、各 agent adapter、`insights`／`usageInsights`。這些範圍的缺陷沒有涵蓋。
- 沒有實際執行任何 run。**每一條都是從程式碼推論**，下面用標記區分把握程度：
  - 【已確認】直接從程式碼讀到行為。
  - 【推論】依程式碼推出的後果，沒有實測。
  - 【未驗證】搜尋不到相關呼叫而推出「沒有」，可能在沒讀的檔案裡。
- `docs/compare-agfnow-agentflow.md` 只當輔助。它的「可借鏡 #1 輕量路徑」已由 `run --fast`（commit 4272540）實作，該文件第 21 行「每個 run 都走完整流程」已過時。

## 流程現況（一頁摘要）

```
spec → plan ⇄ plan_review ⇄ plan_fix →（僵持時）仲裁
     → implement（每任務：紅燈寫測試 → 綠燈寫實作 → 任務審查 → 任務驗證 ⇄ 任務修正；可平行成車道再合併）
     → verify ⇄ fix → review ⇄ fix → pr → done
```

關卡的設計原則是「由程式檢查事實」。現況中程式真正檢查的事實有：zod schema、計畫的任務對 AC 覆蓋（`orderTasks`）、紅燈必須失敗、綠燈測試必須通過、實作不得動測試檔、`outOfScopeFiles`、檢查指令的 exit code、`.flow/` 鎖定檔不得被改、交接帳本結清。下面的缺陷大多是「這個原則在某處沒有被貫徹」。

---

## A. 關卡有漏洞（高）

### A1. 程式碼審查沒有對回驗收條件的覆蓋【已確認】

- `ReviewResult.items[].criterion` 是 `z.string()`（`schemas.ts:135`）。`ConsistentReviewResult` 只檢查 verdict 與 items 是否一致。
- 後果：審查者漏看某條 AC 就 `approve`，程式不會發現；也可以寫出不存在的 criterion。`review.md` 要求「逐條核對」，但只靠 prompt。
- 對比：計畫階段已經做到「每條 AC 恰好由一個任務負責」（`orderTasks`），所以資料基礎齊備，缺的只是最終審查的覆蓋表。
- 建議：`approve` 時要求回報每條 AC 為 `met`（可以讓 items 多一種 `met` 的紀錄，目前 schema 已有 `met` 這個 status 但 prompt 說 approve 時 items 為空），程式比對 AC id 集合；缺漏視為格式錯誤重審。

**修改結果（PR #65）**

- 新增 `src/reviewCoverage.ts` 的 `checkReviewCoverage`。`codeReview` 讀到 `review.json` 後呼叫它：範圍內每條 `AC-n` 都要有一筆回報；`items` 提到不存在的編號不合格。任務審查的範圍是該任務的 `acceptance`，整體審查是 `acceptance.json` 全部；任務審查時其他任務的真實編號放行。
- 不合格時以 `format_invalid` 走原本的 `fail()`：丟掉該審查者的存檔、記一次重試、整輪重審，feedback 會寫出缺哪幾條。
- `prompts/review.md`、`task-review.md` 的輸出格式改成「每條各一筆，通過寫 `met`」，並移除「approve 時 items 為空」的舊說法。
- 限制：只檢查結構，不判斷審查者的 `met` 對不對。這一關擋的是「漏看」，不是「看錯」。
- 測試：新增 `reviewCoverage.test.ts`；`engine.test.ts` 新增漏報與額外發現缺 evidence 兩個重審案例。原有測試裡假審查者原本一律回空的 `items`，已改成逐條回報。

### A2. review ⇄ fix 沒有範圍約束，審查者可無限提需求【已確認】

- `reviewStage` 把所有 `not_met`／`partial` 的 item 原樣寫進 feedback 交給 fix。`review.md` 允許「額外發現的重要問題」，這類 item 不需要對應任何 AC。
- `applyFix` 的防護只有：不可改鎖定檔、不可刪測試、`scopeGuard`（只比對路徑）、交接結清。沒有任何機制檢查「這條意見是否在規格內」。
- 後果：審查者可以用「額外發現」持續擴大範圍，直到撞到 `maxAttempts`（預設 5）使 run 失敗；失敗時使用者看到的是 `retry_limit`，不是範圍膨脹。
- 建議：item 分成兩類——對應 AC（可直接進 fix）與額外發現（必須附 evidence，分開標示；可設定為只當交接事項的 `info`，或需另一位審查者附議才進 fix）。

**修改結果（PR #65）**

- `ReviewResult` 的 item 新增 `evidence` 欄位（預設空字串，舊資料可讀）。`criterion` 不是 `AC-n` 的項目視為額外發現，沒通過的額外發現必須有 `evidence`，否則 `format_invalid`。
- `feedback.md` 裡用 `<extra_finding status evidence>` 與驗收條件的 `<issue>` 分開標示。`prompts/fix.md` 說明：額外發現要先依 evidence 確認是這次變更的缺陷才改，認為是新需求就不實作，改在 `newIssues` 以 `info` 寫明不採納的理由。審查 prompt 也寫明額外發現只限缺陷，不可是新需求、風格偏好或「有更小的做法」。
- 範圍膨脹的剎車：`EXTRA_BLOCK_ATTEMPTS = 1`。該關的重試計數為 0（第一次審查）時，額外發現可以擋關；修過一輪之後若這位審查者只剩額外發現，視同核准，這些發現以 `info` 記進交接帳本。只要還有驗收條件未通過，額外發現仍會一起進 fix。
- 沒做：「需另一位審查者附議才進 fix」。
- 限制：降為 `info` 的額外發現目前不會出現在 PR 描述裡（見 B4）。
- 測試：`engine.test.ts` 新增「第一次擋關且分開標示」與「修過一輪後降為 info」兩個案例。

### A3. verify 只看 exit code，fix 階段沒有紅綠約束【已確認】

- `runChecks` 只回傳每個指令成功或失敗。沒有檢查：最終 diff 是否包含測試變更、測試數量是否減少、coverage 是否下降、斷言是否被放寬。
- TDD 紅綠只在 `implementStage` 強制。`applyFix`（任務與最終）只有「不刪測試檔」。「放寬斷言、`@ts-ignore`、skip」只在 fix 的 prompt 禁止，程式沒有偵測。
- 沒有測試框架時（`hasTestFramework()` 為 false），綠燈直接視為通過（`implementStage` 的 `green` 分支），之後只剩審查把關。
- 建議：fix 提交後比較測試檔 diff，偵測新增的 `skip`／`only`／`todo` 與被刪除的斷言行數；最低限度把偵測結果列進 feedback 或直接退回。

**修改結果（PR #65）**

- 依 `weakenedChecks`（`testGuard.ts`）比對 `git diff`：每個檔案的新增與移除相抵，所以搬移程式碼不會誤判。偵測三類：測試檔新增 `skip`／`only`／`todo`（含 `xit`、`xdescribe`）、程式碼檔案新增 `@ts-ignore`／`@ts-nocheck`／`eslint-disable`、測試檔的斷言（`expect`／`assert*`）變少。`.flow/` 與已刪除的檔案不看；文件與鎖定檔提到抑制字樣不算。
- `applyFix`（任務修正與最終修正共用）：前兩類一律還原並以新分類 `checks_weakened` 重試；斷言變少只在前 `SCOPE_GUARD_ATTEMPTS`（2）次嘗試擋下，之後放行並印警告，因為可能是合理地刪掉重複的斷言。綠燈階段的實作只擋抑制註解。
- 限制：沒有處理「把 `toBe(5)` 改成 `toBeDefined()`」這類換成較弱的比對；`@ts-expect-error` 不算在內（型別測試會合理使用）；`verify` 本身仍只看 exit code，沒有 coverage 檢查；沒有測試框架時綠燈仍直接視為通過，未處理。
- 測試：`testGuard.test.ts` 新增 `weakenedChecks` 的單元測試；`engine.test.ts` 新增修正階段被退回的案例。

### A4. 非 TDD 任務「沒有任何變更」會被靜默略過【已確認】

- `implementStage`：`if (!tdd && !codeCommit)` → 印出「沒有檔案變更，略過這個任務」並 `finishTask`。
- 這個任務的 AC 沒有被實作也一樣前進。只有任務審查（fast 模式沒有）與最終審查能發現。
- 與 A1 疊加：fast 模式只有最終審查，最終審查又沒有 AC 覆蓋檢查，所以非 TDD 任務被略過在 fast 下幾乎沒有程式化的保險。
- 建議：非 TDD 任務沒有變更時，要求 agent 在 `<result>` 或 handoff 說明為什麼不需要變更，且由審查階段強制檢查（或直接視為 `tests_not_written` 類的重試）。

**修改結果（PR #65）：決定不強制審查，改為留紀錄**

- 原本的建議（沒有變更就強制審查）過頭了：設定、文件、純重構或行為早已存在的任務，沒有變更是合理的，強制審查會對正常情況多付一次審查費。
- 真正的缺口是沒有人核對那條驗收條件，這由 A1 的覆蓋表處理：整體審查必須逐條回報全部驗收條件，被略過的任務若其實沒做到，審查者要回報 `not_met`。
- 另外在略過時（`noteSkippedTask`）於交接帳本記一筆 `info`，說明 T-n 沒有檔案變更、請確認其驗收條件在既有程式碼上本來就成立。審查者讀 `handoff-context.md` 時會看到。
- 限制：這只是提示，不是程式強制；若審查者忽略它又在覆蓋表誤標 `met`，仍然漏得過去。fast 模式沒有任務審查，只剩整體審查。
- 測試：略過任務的既有案例新增了對帳本 `info` 的斷言。

### A5. 範圍守衛（`outOfScopeFiles`）只認得「後面任務描述裡出現過的路徑」【已確認】

- `describedPaths` 用 regex 從任務描述抓路徑；`outOfScopeFiles` 只擋「動到後面任務描述提到、但自己描述沒提到的檔案」。
- 完全沒被任何任務描述提到的檔案，任何任務都可以改。路徑寫法不同（相對路徑、glob、目錄）也會漏。
- 守衛只在前 `SCOPE_GUARD_ATTEMPTS` 次嘗試生效（`engine.ts:1585` 附近），超過後放行，是刻意的退讓，但也代表守衛可以被「多試幾次」繞過。
- 影響：車道平行時，兩個任務若動到沒被任何描述提到的同一檔案，會在合併時衝突後整條重做（見 C2）。

**修改結果（PR #65）**

- `tasks.ts` 新增 `describedDirs`，並讓 `describedPaths` 認得根目錄檔案（`package.json`、`tsconfig.json`、`README.md` 等常見副檔名）。`outOfScopeFiles` 改成：動到後面任務明寫的檔案，或後面任務描述的目錄（至少兩層、結尾有斜線，例如 `src/auth/`）底下的檔案，算越界；自己描述了同一目錄或檔案就不算。
- 守衛達 `SCOPE_GUARD_ATTEMPTS` 後放行時，現在會印警告（原本是靜默放行），實作與修正兩處都是。
- 限制（刻意保留）：沒有任何任務提到的檔案仍不受限，因為新增 helper、鎖定檔等無法事先列舉；守衛仍會在達次數上限後放行；描述裡的 `Next.js` 這類字會被當成根目錄檔案，但只拿來和實際變更的檔名比對，不會造成誤擋。
- C1（計畫階段偵測平行任務路徑重疊）沒有處理，所以車道衝突整條重做的成本沒有變。
- 測試：`tasks.test.ts` 新增目錄、根目錄檔案與放行情況。

### A6. 計畫仲裁僵持時預設往前走（fail-open）【已確認】

- `tieBreak` 預設 `"proceed"`（`schemas.ts:286`）。仲裁小組意見分歧（有人核准、有人不核准）時，預設繼續實作。
- 一個不核准的仲裁意見只被寫進 `plan.md` 的「仲裁紀錄」。這些意見沒有進入交接帳本，後續任務不會被要求處理。
- 建議：預設改 `stop`，或至少把不核准一方的意見轉成交接 `action`，讓最終審查把關。

**修改結果（PR #65）**

- `tieBreak` 預設值沒有改，維持 `proceed`（改成 `stop` 是不相容的行為改變）。
- 改為：仲裁分歧而繼續實作時（`recordArbitrationDissent`），沒核准的仲裁者的每則意見記成 `targetStage: "code"` 的待處理事項（`action`）。程式碼類的待處理事項必須由最終審查結案（`resolved` 或 `accepted`），否則審查核准會被判矛盾、PR 階段也會因 `open_handoff` 失敗，所以不再只留在 `plan.md`。重複回報由既有的 `isDuplicateIssue` 去重，同一輪重播以 `arbitration-dissent:<輪次>:<仲裁者>` 為鍵不會重複記。
- 測試：既有的仲裁分歧案例改成預期帳本多出一筆 `code` 類 `action`。

### A7. `reviewQuorum` 預設為 1【已確認】

- 預設只有一位審查者。`codeReview` 的 panel 在 quorum 為 1 時，單一模型的盲點直接成為最終關卡。
- 這是設計取捨（成本），但文件和 README 若沒強調，使用者容易高估「多家互審」的保證。

**修改結果（PR #65）**

- 只改文件：`docs/reference.md` 與 `docs/configuration.md` 的 `reviewQuorum` 說明加上「預設只有一位審查者，單一模型的盲點就是最後一道關卡；重要專案建議設 2 以上，代價是每次審查多花一次 agent 呼叫」。
- 預設值沒有改，因為改成 2 會讓每次審查成本加倍，這是需要使用者決定的取捨。

---

## B. 對外交付與整合（中）

### B1. 沒有對 base 分支做 fetch 或 rebase【未驗證，已搜尋 `fetch|rebase|pull`，`src/*.ts` 無任何呼叫】

- `cli.ts` 的 `run`：`base = opts.base ?? 目前分支`，用 `addWorktree(root, wt, base, branch)` 從**本機**分支建立 worktree。沒有 `git fetch`，也不看 `origin/<base>` 是否領先。
- 後果：
  1. 本機 `main` 落後 `origin/main` 時，整個 run 都在舊基底上驗證。
  2. run 跑得久（尤其有人工等待核准時），push 時 base 早已前進；PR 可能衝突，或沒衝突但與新程式碼語意衝突，而 verify 是在舊 base 上通過的。
- 平行車道有 `mergeBranch` 與合併後全套測試（`mergeLane`），但那只處理車道之間，不處理 base 漂移。
- 建議：開 PR 前 `fetch`，若 `origin/<base>` 領先就嘗試合併（或 rebase）並重跑 verify；衝突時以 `paused` 停下並說明，而不是直接推送。
- 請在動手前先確認這條：若 base 更新在我沒讀的地方處理，結論會不同。

### B2. 推送／建 PR 的錯誤處理不完整【已確認】

- `gh pr create` 失敗：只印警告，仍然 `to(run, "done")`，`prUrl` 為空（`prStage`）。紀錄上 run 是完成的，實際沒有 PR。之後的 `iterate` 因為沒有 `prUrl` 會再走建 PR 流程，但使用者不一定知道。
- `git push` 失敗（例如分支被別人更新、權限不足、非 fast-forward）：丟例外，變成 `failureCategory: "error"`，沒有專屬分類，也沒有下一步指引（`stopReport` 能給的資訊有限）。
- 沒有 `origin` 時直接 `done` 並說「可以直接檢視或合併」，沒有標示這是降級路徑，`insights` 統計會把它算成功。
- 建議：新增 `push_failed`／`pr_create_failed` 的失敗分類；`gh pr create` 失敗時進入 `paused` 而不是 `done`，`resume` 時只重試建 PR。

### B3. PR 之後流程就結束了【已確認】

- `prStage` 建完 PR 就 `done`：不等 CI、不讀 PR 上的 review 留言、不處理 CI 失敗。
- 已有 `iterate` 可以人工補需求開第二輪，但「CI 失敗自動帶回 feedback」這一步沒有。
- 這也是「無人值守做到 PR」定位下最明顯的最後一哩。建議作為選配（例如 `--wait-ci`）：輪詢 `gh pr checks`，失敗時把 log 尾端寫進 `.flow/feedback.md` 回到 fix，最多 N 輪。

### B4. PR 內容偏薄【已確認】

- PR body 是 spec.md 加上待確認清單，標題只取需求第一行前 72 字。
- 沒有：變更摘要、各 AC 的覆蓋對照、測試結果、被接受的交接事項（`accepted`）與其理由、仲裁紀錄、agent 代打紀錄（`substitutions.jsonl`）。審閱 PR 的人看不到「這個結果是怎麼審出來的」。
- 這些資料大部分已經存在 run 目錄裡，組裝成本低。

---

## C. 平行車道（中）

### C1. 衝突重做會丟掉整條車道的工作【已確認】

- `mergeLane`：文字衝突或合併後全套測試失敗時，車道分支 `resetTo(before)`，任務從 `tests` 階段完全重來（`taskIndex: 0`、`taskPhase: "tests"`）。紅燈、綠燈、審查、驗證全部重付。
- 有 `retry` 上限（`${task.id}:merge`），但每次重做的成本是一個完整任務。若兩個任務長期共用一批檔案，等於把平行化的省下來的成本全部吐回去。
- 與 A5 相關：事前的範圍守衛抓不到「沒被描述提到的共用檔案」，所以衝突在最晚的時間點才被發現。
- 建議：計畫階段（`validatePlan`）檢查平行任務的描述路徑是否重疊，重疊就加上 `dependsOn`；或衝突時先嘗試讓原作者 agent 在最新分支上 rebase／解衝突，而不是丟棄。

### C2. 合併後每次都跑全套測試【已確認，屬成本取捨】

- `mergeLane` 每合併一個車道就 `runCommand(... cfg.test)` 全套。N 個任務合併 N 次，測試時間線性累加，且合併是序列的，會成為平行化的瓶頸。
- 好處是能抓語意衝突。可以考慮只在「這個任務與已合併任務有檔案或匯入重疊」時才跑全套，其他情況留給最後的 verify。

### C3. `reserveAgentRun` 與 `exhausted` 只存在程序記憶體【已確認，AGENTS.md 也自述】

- 額度保留（`store.ts`）與 `agentStep` 的 `exhausted` 集合都不跨程序。
- 同一個 repo 同時跑兩個 `agentflowctl` 程序，或 `resume` 與另一個進行中的 run 同時執行，額度與「某家已用完」的判斷不共享。`maxAgentRuns` 的保證只在單一程序內成立。
- 嚴重度視使用情境，單人單 run 為主時影響小。

---

## D. 重試、失敗與復原（中）

### D1. 沒有 flaky 或環境失敗的處理【已確認】

- `verifyStage`／`taskVerifyStep`：檢查失敗一律 `retry(... "fix", "checks_failed")`，把輸出餵給 fix agent。
- 失敗若是 flaky 測試、port 被占用、網路、暫時性環境問題，fix agent 會去「修」不存在的 bug，可能改壞正常程式碼，並消耗 `maxAttempts`。
- 建議：失敗後先**原樣重跑失敗的檢查一次**；第二次通過就記錄為 `flaky` 並放行（同時留下紀錄供 `insights` 統計）；兩次都失敗才叫 fix agent。成本最低、收益明確。

### D2. `resume` 一次清空全部重試計數【已確認】

- `cli.ts` 的 `resume`：`failed` 時 `attempts: {}`、`modelRetryAttempts: {}`。
- 每次 resume 都給滿額的重試次數。對「人已經看過、補了意見」是合理的；但對腳本化或反覆 resume 的情境，等於沒有上限，`maxAgentRuns` 變成唯一的剎車。
- 實作階段失敗後沒有「人工補意見再重試」的專用入口（`replan` 只在計畫階段）。使用者只能手改 `.flow/feedback.md` 之類的檔案，這條路徑沒有文件化。

### D3. `cancel` 只改狀態，不終止程序【已確認】

- `cancel` 把 run 標成 `failed/cancelled`，說明文字也說「執行中的 run 請直接在該終端機按 Ctrl-C」。若程序還在跑，它下一次 `saveRun` 會覆蓋這個狀態。
- 若 agent 子程序仍在跑，它的產出可能在 `cancel` 後才寫入 worktree。

### D4. 退回測試／diverge 等機制複雜，狀態欄位多【推論】

- `testsRedos`、`taskBase`、`testsCommit`、`lastTestsAuthor`、`fixSource`、`lastWriter`、`lastReviewer`、`doneTasks`、`taskOffset`、`modelRetryAttempts`……在 `mergeLane` 的 `redoLane` 與 `finishTask` 都要手動逐一清零。
- 這種「多處手寫重置」很容易漏一個欄位，造成車道重做時帶著舊狀態（例如 `testsRedos` 沒清）。目前測試覆蓋看起來不錯，但這是未來改動最容易出 bug 的地方。
- 建議：把「任務級狀態」收成一個子物件（`task: {index, phase, base, testsCommit, ...}`），整體重置。

---

## E. 審查品質與成本（中、低）

### E1. fix 之後整份重審【已確認】

- `fix → verify → review`：`codeReview` 每輪都對 `run.baseBranch...HEAD` 的**完整 diff** 重新叫整個 panel。只改一行也付完整審查成本。
- 沒有只審 delta 或只叫上次提出反對意見的審查者的選項。需注意 `roles.ts` 的不變式（審查者不能是最後作者），所以不能直接讓同一人審自己的修正。

### E2. 沒有 Minimality 審查項【已確認】

- `review.md`、`task-review.md` 的 `review_focus` 沒有「能否刪減、合併或重用既有行為」。測試抓不到過度實作，審查 prompt 也沒要求。
- 只改 prompt 即可，成本最低。

### E3. 沒有針對信任邊界的安全審查【已確認】

- `review.md` 只在第 2 點籠統提到安全。沒有獨立階段，也沒有「diff 觸及輸入處理、認證、檔案系統、shell 執行、依賴變更」時的強制條件。
- 對這個 repo 自己尤其重要（它本身就會執行 shell 與管理 git）。可以做成選配階段，由 `FastCheck.trustBoundary` 類似的程式化觸發。

### E4. `fast` 模式只留一道最終審查【已確認】

- fast 略過計畫審查與任務審查（`implementStage` 第 1474 行附近）。保險只有最終審查，而最終審查又有 A1（無 AC 覆蓋檢查）。
- fast 的 `FastCheck` 由 agent 自己回報四個旗標，程式只是「依旗標裁決」；旗標本身仍是 agent 自述，不是程式檢查的事實。這和「不看 agent 自述」的原則有落差。
- 建議：用程式可檢查的訊號補強，例如任務數、描述涉及的路徑是否跨越多個頂層目錄、是否動到 `package.json`／設定檔／schema 類檔案。

### E5. 審查者看不到「為什麼這樣做」的決策【推論】

- 審查輸入是 diff、AC、spec、`verify.json`。沒有提供作者的 `<result>` 摘要與 `concerns`（它「只給人看，不影響關卡」）。
- 這是刻意的獨立審查，但也代表作者標明的疑慮不會進到審查。若作者在 `<concerns>` 寫了風險，目前只有交接帳本（`handoff-response.json`）會被帶到審查。確認作者是否一致把重要疑慮寫進 handoff 而不是只寫 `<concerns>`；prompt 已要求，但沒有程式檢查。

---

## F. 可觀測性與規則演進（低）

### F1. 失敗統計沒有回饋到流程【已確認】

- `insights`、`usageInsights` 彙總失敗類別、重試浪費與用量建議，但只是給人看。沒有「某類失敗（例如 `tests_not_red`、`out_of_scope`）在多個 run 反覆出現就調整 prompt 或預設值」的路徑。
- agfnow 的 `incidents-log.md` 把規則連結到事故；我們有資料（`retries.jsonl`）卻沒有「規則 ↔ 失敗案例」的對應，改 prompt 時無從得知是為了什麼而加。

### F2. 模型分級只在 adaptive 模式（`modelSelection`）【已確認，未深讀】

- `selectModel` 依任務 `complexity` 選模型，但「安全審查用最強模型」這類依階段分級沒有對應階段，因為沒有安全階段（見 E3）。

### F3. 沒有跨 run 的整體保護【推論】

- 沒有全域或每日的用量上限，只有單一 run 的 `maxAgentRuns`。無人值守若排程大量 run，成本沒有總閘。

---

## 與 agfnow 比較文件的對照更新

| 比較文件的項目 | 目前狀態 |
|---|---|
| 可借鏡 #1 輕量路徑 | **已完成**（`run --fast`）。但 `FastCheck` 是 agent 自述旗標，見 E4 |
| 可借鏡 #2 審查發現須可追溯 | **已做（PR #65）**：額外發現須附 evidence、分開標示、只在第一次審查能擋關；沒做「對得上規格或驗收條件才進 fix」的硬性要求，對不上驗收條件的發現只要有證據仍會進 fix，見 A2 |
| 可借鏡 #3 驗收編號覆蓋表 | **已完成（PR #65）**：計畫層（任務 ↔ AC）本來就強制，審查層現在也由程式比對編號，對應 A1 |
| 可借鏡 #4 Minimality 審查項 | 未做，對應 E2 |
| 可借鏡 #5 security-scan 選配階段 | 未做，對應 E3 |
| 「我們的 review 迴圈直接採納意見」 | 確認屬實，A2 已用 evidence 與擋關次數限制緩解，沒有完全消除 |

比較文件**沒有**提到、本文新增的類別：B（base 漂移、PR 錯誤處理、CI 回饋）、C（車道重做成本）、D1（flaky）、A3／A4／A5（既有關卡的漏洞）。

---

## 建議優先順序

| 順位 | 項目 | 理由 | 規模 |
|---|---|---|---|
| 1 | A1 審查覆蓋表＋A2 發現分類（**已完成，PR #65**） | 影響最大；純程式關卡，符合專案原則；資料基礎已在 | 中：schema、`codeReview`、兩份 review prompt、測試 |
| 2 | D1 verify 失敗先原樣重跑一次 | 直接省 fix agent 的呼叫；風險低 | 小 |
| 3 | B2 `gh pr create`／push 失敗不標 done | 目前會留下「完成但沒有 PR」的假象 | 小 |
| 4 | B1 開 PR 前對 base 做 fetch／合併檢查 | 避免推出已過時的分支；先確認 B1 的【未驗證】 | 中 |
| 5 | A4 非 TDD 任務無變更不可靜默略過（**已改為留紀錄，PR #65**，不強制審查） | 與 A1 疊加，fast 下尤其沒有保險 | 小 |
| 6 | A3 fix 後偵測測試被放寬（**已完成，PR #65**） | 關卡一致性 | 中 |
| 7 | E2 Minimality 審查項 | 只改 prompt | 小 |
| 8 | A6 `tieBreak` 預設改 `stop`，或把不核准意見轉成交接事項（**已採後者，PR #65**；預設值沒改） | 屬 breaking default，需版本說明 | 小 |
| 9 | C1 計畫階段偵測平行任務路徑重疊 | 降低衝突重做 | 中 |
| 10 | B3 `--wait-ci` 選配 | 補上最後一哩，但範圍較大 | 大 |
| 11 | E1 delta 審查 | 省成本，需處理 `roles.ts` 不變式 | 中 |
| 12 | E3 安全審查選配階段 | 需要觸發條件設計 | 大 |

尚未處理：D1、B2、B1、E2、C1、B3、E1、E3 與 B4、C2、C3、D2 到 D4、E4、E5、F。做任何一項前，依 AGENTS.md：改行為要同步更新 `README.md`；新增 run 狀態欄位要設 optional；改 `roles.ts` 要補 `roles.test.ts`；改 adapter 要用真實 JSON 行補測試。

## 不建議做的事（延續比較文件的結論並補充）

- 讓 LLM 決定流程路徑：違背由程式推進的核心。
- 把 A2 的「須對應 AC」做成只靠 prompt：這正是現在的缺陷來源。
- 為了解 B1 在 engine 內自動 `git rebase` 後直接推送而不重新驗證：會造成「驗證的不是推出去的內容」。一定要在合併後重跑 verify。

## 已知限制

- 本文沒有跑過任何 run，也沒有實測任一缺陷；A1、A2、A4、D1 都建議先寫一個會失敗的測試重現後再動手（`engine.test.ts` 已有大量情境可沿用）。
- PR #65 的測試是實作之後才補的，我沒有逐一驗證它們在修改前會失敗。它們證明新行為存在，不證明舊行為確實有該缺陷。
- 沒讀的範圍（見開頭）可能已經處理了部分問題，也可能有本文沒列到的缺陷。特別是計畫修訂與分層審查（`planFixStage`、`planReviewLayered`）和各 adapter 的額度偵測（`QUOTA_PATTERNS` 只在執行失敗時檢查，若 CLI 以成功碼回報額度不足會被漏掉）值得再單獨審一輪。
