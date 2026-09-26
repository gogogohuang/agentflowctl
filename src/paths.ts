import { execFileSync } from "node:child_process";
import { join } from "node:path";

let root: string | undefined;

/** 目前所在的 git 專案根目錄；agentflowctl 的所有資料都放在 <root>/.agentflowctl/ */
export function projectRoot(): string {
  if (!root) {
    try {
      root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("請在 git 專案資料夾內執行 agentflowctl");
    }
  }
  return root;
}

export const agentflowctlDir = () => join(projectRoot(), ".agentflowctl");
export const runsDir = () => join(agentflowctlDir(), "runs");
export const runDir = (id: string) => join(runsDir(), id);
export const logDir = (id: string) => join(runDir(id), "logs");
export const handoffPath = (id: string) => join(runDir(id), "handoff.json");
/** 每個 run 一個 git worktree，Agent 只在這裡工作，不碰你正在編輯的檔案 */
export const worktreesDir = () => join(agentflowctlDir(), "worktrees");
export const worktreeDir = (id: string) => join(worktreesDir(), id);
export const flowDir = (id: string) => join(worktreeDir(id), ".flow");
