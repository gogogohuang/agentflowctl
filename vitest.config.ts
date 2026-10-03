import { configDefaults, defineConfig } from "vitest/config";

/** 本機 git worktree 裡的測試不要跟主目錄一起跑 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.worktree/**", "**/.worktrees/**"],
  },
});
