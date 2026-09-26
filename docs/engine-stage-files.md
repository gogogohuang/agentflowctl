# 各階段檔案

`.flow/` 在 worktree 裡，agent 看得到，而且不進 git。`.agentflowctl/runs/<id>/` 在 worktree 外，帶有審查者名字的紀錄放這裡，避免後面的 agent 看見是誰寫的。

`state.json` 不屬於單一階段。它是這次 run 的進度本身：目前停在哪個階段、做到第幾個任務、紅燈還是綠燈、各關失敗了幾次、計畫與程式最後是誰寫的。程式每一步結束都原子寫入，所以中斷後 `resume` 能從同一個階段繼續，`status` 也能畫出任務進度。agent 不讀這份檔。

每個階段分成兩張表。**輸入**是進入這一步時已經存在、這一步會讀的檔。**產出**是這一步寫出、改寫或移走的檔。同一份檔若又讀又寫（例如修訂規格），兩張表都會出現。`feedback.md` 的覆寫與刪除細節見下方專節。

## spec

把需求收成一份共用規格，並把完成條件收成程式能點名的清單。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| 需求（prompt） | 這次 run 要做的事，來自 `state.json` 的 `requirement`，不是 `.flow` 檔 | 建立 run 的人 | 規格 agent |
| 既有程式 | 對齊專案現況與慣例，規格才不會另起一套做法 | 專案原本就有 | 規格 agent |
| `feedback.md` | 只在重試時存在。告訴規格 agent 上次是缺檔、驗收 JSON 不合法，還是 id 重複 | 上一輪 spec 的程式 | 規格 agent。prompt 要求檔案存在就先讀 |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `spec.md` | 做什麼、不包含什麼、介面或資料結構、風險，以及需求不清楚時採用的假設。後面的計畫、實作、審查都對齊這份文字。程式只檢查檔案在不在 | 規格 agent | 計畫、計畫審查、計畫修訂、仲裁、紅燈、綠燈、修正、程式碼審查；`pr` 用來組成 PR 內文 |
| `acceptance.json` | 「怎樣算完成」的清單，`id` 為 `AC-<數字>`，每條都要能寫成自動測試。程式用它擋住重複 id 和空清單 | 規格 agent | 計畫階段做覆蓋檢查；之後的審查讀內容。實作做完後不再逐條核對 id，是否真的被測試覆蓋留給程式碼審查 |
| `feedback.md` | 這一輪沒過時覆寫，讓下一次 spec 知道原因。通過後刪除 | 程式，`retry("spec")` | 下一輪規格 agent |

## plan

把規格拆成一次 TDD 循環能做完的任務，並排出沒有循環的順序。一個任務只做一件事，最多兩件：`validatePlan` 會退回對應超過兩條驗收條件的任務。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `spec.md` | 拆任務時對齊的範圍與做法邊界 | 規格 agent | 計畫 agent |
| `acceptance.json` | 每一條驗收條件都要有任務負責。程式也用同一份 id 做覆蓋檢查 | 規格 agent | 計畫 agent；程式在 `validatePlan` 再讀一次 |
| `feedback.md` | 只在重試時存在。帶著上次 DAG 或格式為什麼不合法 | 上一輪 plan 的程式 | 計畫 agent。prompt 要求檔案存在就先讀 |
| 既有程式 | 任務要落在專案現有的模組上 | 專案原本就有 | 計畫 agent |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `plan.md` | 要動哪些模組、任務為什麼排成這個順序。審查與仲裁用它判斷做法能不能滿足需求；人工確認時人看的也是這份 | 計畫 agent | 計畫審查、修訂、仲裁、紅燈、綠燈 |
| `tasks.json` | 工作項目原文：做什麼、依賴誰、負責哪些 `AC-*`。程式不採用 agent 口述的順序，而是讀這份來排序 | 計畫 agent | 計畫審查、修訂、仲裁；程式用來產生 `tasks.ordered.json` |
| `tasks.ordered.json` | 已按相依關係排好的進度清單。implement 每次只取一項，`status` 用它畫進度。agent 不改這份 | 程式，DAG 檢查通過後寫入 | implement、`status` |
| `plan-review-last.txt` | 新計畫定稿時刪除，讓之後的審查從第一輪指紋重新算，不沿用舊爭議 | 程式刪除 | 下一輪 plan_review 的僵持判斷 |
| `feedback.md` | 這一輪沒過時覆寫。通過後刪除 | 程式，`retry("plan")` | 下一輪計畫 agent |

## plan_review

在寫程式前確認這份計畫照著做不會做錯，也不會無法驗收。仲裁的讀寫另列在下一節。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| 需求（prompt） | 對照規格有沒有漏掉或加進出原本沒要求的範圍 | 建立 run 的人 | 計畫審查 agent |
| `spec.md` | 審查的規格正文 | 規格或計畫修訂 agent | 計畫審查 agent |
| `acceptance.json` | 檢查每條完成條件是否具體、能否用測試驗證 | 規格或計畫修訂 agent | 計畫審查 agent |
| `plan.md` | 檢查做法與模組切分。若上一輪修訂過，文末應有審查回應 | 計畫或計畫修訂 agent | 計畫審查 agent |
| `tasks.json` | 檢查任務是否只做一件事（最多對應兩條驗收條件）、相依是否合理、驗收條件有沒有人接 | 計畫或計畫修訂 agent | 計畫審查 agent |
| 既有程式 | 確認計畫符合專案實際架構 | 專案原本就有 | 計畫審查 agent |
| `plan-review-last.txt` | 上一輪未達成意見的指紋。這一輪拿來比對有沒有進展。第一輪或不存在時不構成僵持 | 上一輪 plan_review 的程式 | 程式。agent 不讀 |
| `feedback.md` | 計畫修訂成功後可能仍留在 `.flow`，內容是上一輪意見。審查 prompt 沒有把它列為必讀 | 上一輪 plan_fix 寫回 | 審查者若自己打開才看得到 |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `plan-review.json` | 這一位審查者的正式裁決。`verdict` 決定算不算反對，未達成的 `items` 才會變成修訂意見。程式只認這份 JSON，驗證後立刻移走 | 計畫審查 agent | 程式 |
| `reviews/plan-review-<輪次>-<審查者>.json` | 第幾輪、哪一位、核准或要求修改的原檔。放在 worktree 外，修訂者與仲裁者看不到是誰寫的 | 程式自 `.flow` 移出 | 人 |
| `plan-review-last.txt` | 這一輪未達成意見排好後的指紋，供下一輪判斷爭議有沒有前進 | 程式 | 下一輪 plan_review 的程式 |
| `feedback.md` | 有人要求修改、且尚未送仲裁時覆寫。每位審查者的意見以 `<opinion author="…">` 包住，交給修訂者。agent 執行失敗或 JSON 不合法則用計數鍵 `plan-review-run`，整輪重跑。全員核准時刪除 | 程式，`retry("plan-review")` | 計畫修訂 agent |
| `dispute.md` | 意見與上一輪相同，或輪數已達上限，且開啟仲裁時才寫。只留 `<issue>` 意見，不含審查者名稱 | 程式 | 仲裁 agent |
| `reviews/dispute-full.md` | 同一份爭議，以 `<opinion author="…">` 保留審查者名字，供人事後對照 | 程式 | 人 |

## 仲裁

仍由 `plan_review` 這一步叫起。讀寫的檔和普通審查不同，所以分開列。要回答的只有一件事：照目前計畫做，能不能滿足原始需求。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| 需求（prompt） | 裁決的對照基準 | 建立 run 的人 | 仲裁 agent |
| `spec.md`、`acceptance.json`、`plan.md`、`tasks.json` | 目前的規格與計畫。`plan.md` 文末是作者對審查意見的回應 | 計畫或計畫修訂 agent | 仲裁 agent |
| `dispute.md` | 尚未被接受的意見，已拿掉模型名稱 | 剛結束的 plan_review | 仲裁 agent |
| `feedback.md` | 進入仲裁前程式會刪掉，避免仲裁者讀到帶審查者名字的報告 | 程式刪除 | 仲裁 agent 讀不到 |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `plan-arbiter.json` | 這一票：可以開工，或必須再修。程式用全體 `verdict` 決定放行、交回修訂，或停下等人。JSON 不合法時 run 暫停，檔案留在 `.flow` | 仲裁 agent | 程式。有效則移走；無效則留給 `resume` 前查看 |
| `reviews/plan-arbiter-<輪次>-<仲裁者>.json` | 每位仲裁者的原始裁決。雙盲分歧時，人靠它看 `tieBreak` 為什麼那樣走 | 程式自 `.flow` 移出 | 人 |
| `dispute.md` | 裁決結束後刪除，避免之後的實作者把它當成另一份規格 | 程式刪除 | 無 |
| `feedback.md` | 只有「交回修訂」時寫入，標題是「仲裁要求修訂」，每位仲裁者的理由以 `<opinion>` 包住 | 程式 | 計畫修訂 agent |
| `plan.md` | 放行或停止時，在文末附加「仲裁紀錄」，讓理由留在同一份計畫裡。交回修訂時不改這份 | 程式附加 | 人；若放行，之後的紅燈與綠燈也讀得到 |
| `plan-review-last.txt` | 交回修訂時刪除，下一輪審查的指紋從頭算 | 程式刪除 | 下一輪 plan_review |

## plan_fix

依審查或仲裁意見改正規格與任務。不同意要寫出理由。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| 需求（prompt） | 改規格時仍要對得上原始需求 | 建立 run 的人 | 計畫修訂 agent |
| `feedback.md` | 這一步的工作清單：帶名字的審查意見，或「仲裁要求修訂」全文。prompt 要求一定要讀，並逐條處理 | plan_review 或仲裁 | 計畫修訂 agent |
| `spec.md` | 要被改的規格現稿 | 上一輪規格或修訂 | 計畫修訂 agent；失敗時程式用快照還原 |
| `acceptance.json` | 要被改的驗收清單 | 上一輪規格或修訂 | 同上 |
| `plan.md` | 要被改的做法。回應會寫在這份文末 | 上一輪計畫或修訂 | 同上 |
| `tasks.json` | 要被改的任務原文 | 上一輪計畫或修訂 | 同上 |
| 既有程式 | 確認改動落在實際架構上 | 專案原本就有 | 計畫修訂 agent |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `spec.md` | 改正後的規格。審查若認為需求被誤解、範圍不對或漏了行為，改的是這份正文 | 計畫修訂 agent | 下一輪計畫審查與仲裁 |
| `acceptance.json` | 補上測不到的邊界，或拿掉不屬於需求的條件。格式仍須通過 id 與覆蓋檢查，否則四個規格檔一起還原 | 計畫修訂 agent | 下一輪計畫審查與仲裁；程式重做格式檢查 |
| `plan.md` | 調整後的做法。文末「審查回應」逐條說明改了什麼，或不同意的理由。仲裁只看這份回應 | 計畫修訂 agent | 下一輪計畫審查與仲裁 |
| `tasks.json` | 拆開過大的任務、補上沒人負責的驗收條件、修正相依 | 計畫修訂 agent | 下一輪審查；程式用它重排 |
| `tasks.ordered.json` | 四個規格檔通過 DAG 檢查後才覆寫。沒過則不更新，並還原規格四檔 | 程式 | 之後若計畫定案，交給 implement |
| `feedback.md` | 失敗時把進入時的原文再包一層，並附上執行失敗或格式錯誤。成功時把進入時讀到的原文原樣寫回，不刪除 | 程式 | 失敗時給下一輪修訂；成功時留在 `.flow`，下一輪審查 prompt 仍不要求必讀 |

## implement

依 `tasks.ordered.json` 逐項做。紅燈與綠燈的輸入、產出不同。

### 紅燈輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `tasks.ordered.json` 的目前一項 | 這一步只做這一項。程式把該項 JSON 放進 prompt，不把整份清單交給 agent | 計畫階段的程式 | 測試 agent |
| `spec.md`、`plan.md` | 補上整份規格與做法，讓測試對齊範圍，包含任務標題沒寫到的介面與限制 | 規格與計畫階段 | 測試 agent |
| `feedback.md` | 只在這個任務的紅燈重試時存在。說明上次沒寫到測試、沒有變更，或測試在實作前就全部通過 | 上一輪紅燈的程式 | 測試 agent |
| 既有程式與既有測試 | 新測試要接在現有套件上 | 專案與先前任務的 commit | 測試 agent |

### 紅燈產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| 符合 `testPattern` 的測試檔，以及對應 commit | 證明這個任務的新行為有被測試描述，而且功能還沒寫時整份測試指令會失敗。這顆 commit 是綠燈不能改測試的基準 | 測試 agent 寫檔；程式 commit，訊息含任務 id 與實際作者 | 測試指令；綠燈 agent 只能讀 |
| `red-output.txt` | 紅燈那次失敗的完整輸出，讓綠燈作者知道缺哪段行為、哪一個斷言沒過 | 程式 | 綠燈 prompt 的 `red_output` |
| `feedback.md` | 紅燈沒過時覆寫。通過後刪除 | 程式，`retry("<任務>:tests")` | 同一任務的下一次紅燈 |

### 綠燈輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `tasks.ordered.json` 的目前一項 | 和紅燈同一項任務 | 計畫階段的程式 | 實作 agent |
| `spec.md`、`plan.md` | 實作對齊的規格與做法 | 規格與計畫階段 | 實作 agent |
| `red-output.txt` | 紅燈失敗輸出。程式截斷後放進 prompt，實作 agent 不用自己打開檔案 | 紅燈的程式 | 程式轉入 prompt；實作 agent 讀 prompt |
| 紅燈 commit | 測試已經在這顆 commit 裡。綠燈相對它若改到測試檔，整段會被還原 | 紅燈的程式 | 程式用 `git diff` 檢查；實作 agent 在工作區裡讀測試 |
| `feedback.md` | 只在這個任務的綠燈重試時存在。說明上次改了測試檔，或測試仍未通過並附上輸出尾段 | 上一輪綠燈的程式 | 實作 agent |

### 綠燈產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| 產品程式碼，以及對應 commit | 用最小實作讓紅燈測試通過，且相對紅燈 commit 沒有改測試檔。通過後任務索引才前進 | 實作 agent 寫檔；程式 commit | 後續任務、verify、審查（經由 `diff.patch`） |
| `feedback.md` | 綠燈沒過時覆寫。通過後刪除。測試仍失敗時，失敗的實作 commit 留在分支上 | 程式，`retry("<任務>:code")` | 同一任務的下一次綠燈 |

## verify

確認工作區能安裝，而且設定裡的檢查全部通過。這一步沒有 agent。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| 工作區裡的程式與測試 | `install` 與每個 check 實際跑的對象 | implement 或上一輪 fix 的 commit | 程式執行的指令 |
| `flow.config.json` 的 `install`、`checks` | 要跑哪些指令。每次重新讀取，不在 `.flow` | 專案設定 | 程式 |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `verify.json` | 這一輪安裝與每個檢查的結束碼和輸出尾段。全過才進入程式碼審查，讓審查把注意力放在驗收條件有沒有被實作與測試 | 程式 | 程式決定通關；程式碼審查 agent |
| `feedback.md` | 有項目失敗時覆寫，每個失敗 check 一節。`install` 失敗時只有 install，不附後續檢查。同時把 `fixSource` 設成 `verify`。全過時刪除 | 程式，`retry("verify")` | 修正 agent。修正 agent 不讀 `verify.json` |

## fix

依驗證輸出或程式碼審查意見改正程式。成功後一律回到 verify，不直接回到審查。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `feedback.md` | 這一步的問題清單。來源是 verify 的失敗輸出，或審查未達成項目。prompt 把它列為必讀 | verify 或 review | 修正 agent |
| `spec.md`、`acceptance.json` | 判斷該補實作還是調整測試，以及改動是否仍對得上要交付的行為 | 規格階段 | 修正 agent |
| 目前分支上的程式與測試 | 要被修改的樹 | implement 或上一輪 fix | 修正 agent |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| 修正 commit | 讓下一輪 verify 跑改過的樹。若刪了測試檔，程式還原這顆 commit | 修正 agent 寫檔；程式 commit | 下一輪 verify；之後的 `diff.patch` |
| `feedback.md` | 失敗時把進入時的原文再包一層，並附上 agent 失敗或「刪了測試檔」。成功時不改、不刪，留到之後 verify 通過才刪 | 程式，`retry("fix")` | 下一輪修正 agent；verify 通過前都還在 |

## review

確認每條驗收條件都有被實作，而且有測試真的驗證到。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `spec.md` | 要交付的行為 | 規格階段 | 程式碼審查 agent |
| `acceptance.json` | 可點名的完成條件。審查逐條看有沒有被實作與測試 | 規格階段 | 程式碼審查 agent |
| `verify.json` | 機械檢查已經通過的證據。審查用它把注意力留在行為與測試，編譯與測試指令的結果看這份 | verify 的程式 | 程式碼審查 agent |
| `diff.patch` | 相對基底分支的完整變更。程式在每位審查者開始前重算，所以輸入就是當時的 `HEAD` | 本階段開始時由程式寫入 | 程式碼審查 agent |
| commit 標題裡的作者名 | 程式從 `base..HEAD` 的訊息取出 `[agent]`，放進 prompt，讓審查者知道作者是誰 | implement 與 fix 的 commit | 程式轉入 prompt |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `diff.patch` | 審查者要讀的變更。每位審查者開始前覆寫 | 程式 | 當輪的程式碼審查 agent |
| `review.json` | 這一位審查者的正式裁決。全員 `approve` 才進入 PR。程式只認這份 JSON，驗證後改名 | 程式碼審查 agent | 程式 |
| `review-<審查者>.json` | 具名裁決，留在 `.flow` 供人查看是誰要求改什麼。修正迴圈不讀這些原檔 | 程式改名 | 人 |
| `feedback.md` | 有人要求修改時，把所有未達成項目收成一份清單，小標帶審查者名字，並把 `fixSource` 設成 `review`。執行失敗或 JSON 不合法用 `review-run`，不寫進這份意見清單。全員核准時刪除 | 程式，`retry("review")` | 修正 agent。審查 prompt 沒有把它列為必讀 |

## feedback.md

整個 run 只有這一個檔，路徑是 worktree 裡的 `.flow/feedback.md`。它不是意見歷史，每次寫入都整份覆蓋。agent 不寫這個檔；內容一律由程式組出來。下一輪 agent 用它知道上次卡在哪，不靠終端機上的 `<result>`。

通過某一關時，`succeed()` 會刪除它，並清掉該關的失敗次數。`plan_fix` 與 `fix` 成功時不走 `succeed()`，所以檔案會留著，規則見下表。連續失敗達到 `maxAttempts`（預設 3）時，程式仍會先寫入這份檔，再把 run 標成 `failed`。`resume` 失敗的 run 會清空次數並從失敗階段重跑，這份檔還在，重跑的 agent 讀得到上次的原因。

### 兩種內文

多數重試走 `retry()`，標題固定：

```markdown
# 前次嘗試未通過（第 N 次）

<這次的原因>
```

`N` 是該計數鍵的連續失敗次數，不是整個 run 的第幾步。不同鍵分開算，例如 `spec`、`plan`、`plan-review`、`plan-review-run`、`plan-fix`、`T-1:tests`、`T-1:code`、`verify`、`fix`、`review`、`review-run`。審查意見的往返用 `plan-review` 或 `review`；agent 當掉或 JSON 不合法用 `*-run`，不會把「格式錯誤」算進「意見沒被接受」的次數。

仲裁要求修訂時不走這個標題，改寫成：

```markdown
# 仲裁要求修訂（第 N 次）

<一致不核准，或分歧後依 tieBreak 交回修訂的摘要>

<opinion author="仲裁者" verdict="changes_requested">
<issue criterion="驗收條件">修訂理由</issue>
</opinion>
```

這裡的 `N` 是仲裁輪數。內文含仲裁者名字。計畫審查與程式碼審查的意見也採相同格式：每位審查者一個 `<opinion author="…">`，每個未達成項目一個 `<issue criterion="…" status="…">…</issue>`。agent 文字中的 `&`、`<`、`>`、引號會跳脫。對照用的 `dispute.md` 只放 `<issue>`，不放審查者名稱；仲裁一開始會先刪除當時的 `feedback.md`，避免仲裁者讀到具名報告。

### 誰會讀

| 下一步 | prompt 怎麼要求 |
| --- | --- |
| 規格、計畫 | 檔案存在就先讀，依內容改正前次產出 |
| 紅燈、綠燈 | 檔案存在就先讀，依內容調整 |
| 計畫修訂 | 一定要讀，裡面是審查或仲裁意見，要逐條接受或寫出不同意的理由 |
| 修正 | 把它當成失敗的檢查或程式碼審查意見 |
| 計畫審查、程式碼審查、仲裁 | prompt 沒有把它列為輸入。審查看規格與計畫（或 diff）；仲裁看 `dispute.md` |

### 各階段放進去的原因

| 階段與計數鍵 | 原因內文 | 寫完之後 |
| --- | --- | --- |
| spec／`spec` | agent 執行失敗摘要、缺少 `spec.md`、驗收 JSON 錯誤、驗收 id 重複 | 停在 spec。通過後刪除 |
| plan／`plan` | agent 執行失敗摘要，或任務 DAG 檢查的整段錯誤 | 停在 plan。通過後刪除 |
| plan_review／`plan-review` | `計畫審查要求修改：` 加上每位未核准審查者的 `<opinion>` 與未達成 `<issue>`；`author` 含審查者名字 | 進入 plan_fix |
| plan_review／`plan-review-run` | agent 執行失敗摘要，或 `plan-review.json` 驗證錯誤 | 停在 plan_review，整輪審查重跑 |
| 送仲裁 | 不寫新內容，直接刪除 | 意見改放 `dispute.md`（無名字）與 `reviews/dispute-full.md`（有名字） |
| 仲裁修訂 | 上面的「仲裁要求修訂」全文，含仲裁者名字與每人裁決 | 進入 plan_fix，並把 `plan-review` 次數歸零 |
| plan_fix 失敗／`plan-fix` | 進入時讀到的全文，再附加 agent 執行失敗，或「格式檢查沒過、已還原」與錯誤說明 | 停在 plan_fix。因此失敗越多次，舊標題會包在新標題裡面 |
| plan_fix 成功 | 把進入時讀到的原文原樣寫回，不另加「第 N 次」 | 進入下一輪 plan_review。`plan-fix` 次數清掉。檔案留在 `.flow`，讓下一輪審查看得到上次的意見；審查 prompt 仍不要求必讀。若再次要求修改，`retry("plan-review")` 會整份覆蓋 |
| 紅燈／`<任務 id>:tests` | 執行失敗、沒有任何變更、沒有改到測試檔、或測試在實作前就全部通過 | 停在該任務的紅燈。通過後刪除 |
| 綠燈／`<任務 id>:code` | 執行失敗、改了測試檔（含檔名）、或測試仍未通過並附上輸出尾段 | 停在該任務的綠燈。通過後刪除。測試仍失敗時，失敗的實作 commit 留在分支上 |
| verify／`verify` | 每個失敗項目一節：`## <check 名稱> 失敗` 與輸出。install 失敗就只有 install 這一節 | 進入 fix，`fixSource` 為 `verify` |
| review／`review` | `程式碼審查要求修改：` 加上每位未核准審查者的 `<opinion>` 與未達成 `<issue>` | 進入 fix，`fixSource` 為 `review` |
| review／`review-run` | agent 執行失敗摘要，或 `review.json` 驗證錯誤 | 停在 review，整輪重跑 |
| fix 失敗／`fix` | 進入時讀到的全文，再附加 agent 執行失敗，或「刪了測試檔、已還原」 | 停在 fix |
| fix 成功 | 不改、不刪 | 進入 verify。檔案繼續留著，直到 verify 通過才由 `succeed("verify")` 刪除 |
| 計畫定案、verify 通過、review 全員核准 | `succeed()` 刪除 | 分別進入實作（或等人核准）、review、pr |

## pr

把完成的分支交出。沒有 agent。

### 輸入

| 檔案 | 用途 | 誰準備的 | 這個階段誰讀 |
| --- | --- | --- | --- |
| `spec.md` | PR 正文的規格來源，使用定案後的全文 | 規格階段 | 程式，寫入 `pr-body.md` 時讀取 |
| 目前分支與 `origin` | 決定只留在本機，或推送後開 PR | implement、fix 的 commit；遠端設定 | 程式 |
| `state.json` 的 `cycle`，以及 agent 執行次數 | 寫進 PR 開頭，說明這次 run 有誰參與、跑了幾次 | 程式在整個 run 中累積 | 程式 |

### 產出

| 檔案 | 用途 | 誰寫 | 交給誰 |
| --- | --- | --- | --- |
| `runs/<id>/pr-body.md` | 給 `gh pr create` 的說明：參與者、agent 次數，加上整份 `spec.md`。放在 worktree 外。沒有 `origin` 時不會寫這份；`gh` 失敗時檔案仍留下，供人手動開 PR | 程式，且遠端存在 `origin` | `gh pr create`，或人 |
| 遠端分支 | `git push -u origin` 的結果。push 成功後階段即為 `done` | 程式 | 遠端；`gh` 用它當 PR head |
| `state.json` 的 `prUrl` | `gh pr create` 成功時寫入網址 | 程式 | `status` 與人 |
