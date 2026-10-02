# 發版（維護者）

在 clone 下來的 repo 裡用 `pnpm release <patch|minor|major|x.y.z> [--dry-run]` 發版，只能在 `main` 執行：

```bash
pnpm release patch --dry-run   # 只檢查與驗證，不建立 Release
pnpm release minor             # 確認後建立 v0.x+1.0 的 GitHub Release
pnpm release 1.0.0             # 指定版本，必須大於目前最新的 tag
```

腳本會先檢查目前在 `main`、工作區乾淨、與 `origin/main` 同步、`gh` 已登入、新 tag 不存在，再跑 typecheck、test、build（通過只顯示 ✓，失敗才印出完整輸出），列出自上個 tag 以來的 commit 並等你輸入 `y` 確認，接著把 `package.json` 的 `version` 更新為新版號、commit 並 push 到 `main`，再用 `gh release create --generate-notes` 建立 Release。npm 由 Release 觸發的 `npm-publish.yml` 發布。
