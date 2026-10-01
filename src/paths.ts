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

/**
 * 平行任務的「車道」：每個沒有相依關係的任務在自己的 worktree 與分支上跑完整的任務流程，完成後合併回 run 的分支。
 * 車道當成一個小 run：id 是 `<run id>+<任務 id>`，有自己的 state.json、worktree 與 .flow/，
 * 但 log、用量、重試、代打與交接紀錄都寫進所屬 run，所以統計、次數上限與交接帳本不必另外合併。
 */
export const LANE_SEP = "+";
export function laneParts(id: string): { parent: string; task: string } | undefined {
  const i = id.indexOf(LANE_SEP);
  return i < 0 ? undefined : { parent: id.slice(0, i), task: id.slice(i + 1) };
}
export const laneId = (parent: string, task: string) => `${parent}${LANE_SEP}${task}`;
/** 車道所屬的 run；一般 run 就是自己 */
export const ownerId = (id: string) => laneParts(id)?.parent ?? id;
export const lanesDir = (parent: string) => join(runsDir(), parent, "lanes");
export const runDir = (id: string) => {
  const lane = laneParts(id);
  return lane ? join(lanesDir(lane.parent), lane.task) : join(runsDir(), id);
};
/** 車道和所屬 run 共用的紀錄位置（log、用量、重試、代打、交接） */
export const sharedRunDir = (id: string) => join(runsDir(), ownerId(id));
export const logDir = (id: string) => join(sharedRunDir(id), "logs");
export const handoffPath = (id: string) => join(sharedRunDir(id), "handoff.json");
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
export const worktreeDir = (id: string) => (laneParts(id) ? join(runDir(id), "worktree") : join(worktreesDir(), id));
export const flowDir = (id: string) => join(worktreeDir(id), ".flow");
