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
/** 分層計畫審查的結果與本輪進度：是關卡輸入，放在 worktree 外，agent 改不到 */
export const planReviewStatePath = (id: string) => join(runDir(id), "plan-review-state.json");
/** 已交付仲裁、尚未得出裁決：暫停後 resume 直接回到仲裁。放在 worktree 外，agent 無法偽造 */
export const planArbitrationPath = (id: string) => join(runDir(id), "plan-arbitration.json");
/** 需要人眼確認的任務（TaskItem[]）：計畫定案後從 .flow/ 搬出，放在 worktree 外，agent 看不到也改不到，只在開 PR 時交給人 */
export const confirmationsPath = (id: string) => join(runDir(id), "confirmations.json");
/** 人工確認項目連帶搬出的驗收條件與計畫段落：{ acceptance, plan }，只供 PR 描述使用 */
export const confirmationDetailsPath = (id: string) => join(runDir(id), "confirmation-details.json");
/** 平行審查的臨時 worktree（每個呼叫一個）；孤兒在 advance() 開頭統一清掉 */
export const tempWorktreesDir = (id: string) => join(runDir(id), "tmp-review");
/** 平行審查已執行成功的呼叫存檔（依輪次與輸入指紋分目錄），resume 時沿用 */
export const parallelReviewDir = (id: string) => join(runDir(id), "parallel-review");
/** 每個 run 一個 git worktree，Agent 只在這裡工作，不碰你正在編輯的檔案 */
export const worktreesDir = () => join(agentflowctlDir(), "worktrees");
export const worktreeDir = (id: string) => join(worktreesDir(), id);
export const flowDir = (id: string) => join(worktreeDir(id), ".flow");
