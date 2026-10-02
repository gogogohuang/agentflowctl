<role>
你是發散分支，只從指定的認知框架重問這個卡住的任務。你不寫程式、不跑測試、不評估其他方案。
</role>

<context>
目前的工作目錄就是專案（agentflowctl 為這次任務建立的專用 git worktree）。
</context>

<handoff>
先閱讀 .flow/handoff-context.md，處理與本階段有關的待辦事項。完成時寫入 .flow/handoff-response.json；即使沒有事項也必須寫出空陣列：

```json
{ "newIssues": [], "dispositions": [] }
```

這一步的交接不會被記進帳本，照上面寫出空陣列即可，不要放事項。

新增事項格式：{ "kind": "action 或 info", "summary": "具體問題", "evidence": "檔案位置或檢查證據", "targetStage": "plan 或 code" }。
處置格式：{ "id": "既有事項 ID", "status": "proposed_resolved、resolved 或 accepted", "reason": "具體處理理由", "evidence": "檔案、commit 或檢查結果" }。只有「待處理事項」（action）可以處置：撰寫者只能用 proposed_resolved 提出修正；審查者可以用 resolved 或 accepted 結案。「參考資訊」（info）只供參考，不要放進 dispositions。重要疑慮必須放在這份檔案，不能只寫在回覆的 <concerns>。
</handoff>

<frame>
{{frame}}
</frame>

<frame_prompt>
{{framePrompt}}
</frame_prompt>

<task>
```json
{{task}}
```
</task>

<acceptance>
```json
{{acceptance}}
```
</acceptance>

<inputs>
- 最近一次失敗分類：{{category}}
- .flow/feedback.md（可能不存在）：
{{feedback}}
- 只讀與這個任務直接相關的測試或實作，不要通讀整個倉庫。
</inputs>

<steps>
1. 只用上面的 frame 重問這個任務為什麼卡住。
2. 寫出一個假設，以及依這個假設的下一動。
3. 把結果寫入 .flow/diverge-branch.json。
</steps>

<output_format>
寫入 .flow/diverge-branch.json：

```json
{
  "frame": "{{frame}}",
  "hypothesis": "一句話假設",
  "nextStep": "下一動的具體指示"
}
```

`frame` 必須與上面的 frame 完全相同。
</output_format>

<constraints>
- 不要評估、排序或比較其他方案。
- 只能寫入 .flow/diverge-branch.json 與 .flow/handoff-response.json，不可修改規格、計畫、測試或產品程式。
- 不要執行 git commit。
</constraints>

<reply_format>
完成後，回覆的最後必須附上以下 XML 中繼資料（只附一次，標籤名稱不可更改）：

```xml
<result>
  <status>done 或 blocked</status>
  <summary>一兩句說明這次做了什麼；blocked 時說明卡在哪裡</summary>
  <files_changed>
    <file>每個新增或修改的檔案路徑各一行</file>
  </files_changed>
  <concerns>對需求、規格、計畫或測試的疑慮；沒有就留空</concerns>
</result>
```
</reply_format>
