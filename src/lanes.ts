import type { TaskItem } from "./schemas.js";

/**
 * 平行任務的排程：沒有相依關係（或相依的任務都已合併）的任務各占一條車道同時執行，
 * 車道跑完後依完成順序、一次一個地合併回 run 的分支，合併後才解鎖依賴它的任務。
 * 這裡只管排程，不認得 git 或 agent，車道怎麼跑、怎麼合併由呼叫端提供。
 */

export type LaneOutcome =
  | { kind: "done" }
  | { kind: "failed"; reason: string; category?: string }
  | { kind: "paused"; reason: string }
  /** 車道裡的任務寫了 .flow/amend-request.json：request 是原文，由呼叫端判斷 */
  | { kind: "amend"; request: string };

/** 處理修補請求的結果：retry＝請求不合格，同一車道帶著回饋重跑；restart＝已插入修補任務，停止開新車道，讓呼叫端重新排程 */
export type AmendResolution = "retry" | "restart" | { kind: "failed"; reason: string; category?: string } | { kind: "paused"; reason: string };

export interface LaneHooks {
  /** 讓這個任務在自己的車道跑到完成（或失敗、暫停）；已有進度的車道要接著跑 */
  start(task: TaskItem): Promise<LaneOutcome>;
  /** 把完成的車道合併回 run 的分支；衝突時回傳 "redo"，排程會讓同一個任務重跑；衝突重試達上限則回報失敗 */
  merge(task: TaskItem): Promise<"merged" | "redo" | { kind: "failed"; reason: string; category?: string }>;
  /** 處理車道提出的修補請求；沒提供就把請求視為失敗 */
  amend?(task: TaskItem, request: string): Promise<AmendResolution>;
}

export interface LaneResult {
  /** 已合併的任務（含起始就算完成的） */
  done: Set<string>;
  failed?: { task: TaskItem; reason: string; category?: string };
  paused?: string;
  /** 修補任務已插入：已在跑的車道收尾後停止，呼叫端要重新排程 */
  restart?: boolean;
}

/** 順序執行時已完成的（taskIndex 之前），加上平行模式已合併的 */
export function doneSet(tasks: readonly TaskItem[], taskIndex: number, doneTasks: readonly string[] = []): Set<string> {
  return new Set([...tasks.slice(0, taskIndex).map((t) => t.id), ...doneTasks]);
}

/**
 * 現在可以開始的任務：還沒完成、不在 skip 裡，而且相依的任務都已完成。
 * 相依的 id 不在清單裡（例如已搬去人工確認的任務）視同完成。
 */
export function readyTasks(tasks: readonly TaskItem[], done: ReadonlySet<string>, skip: ReadonlySet<string> = new Set()): TaskItem[] {
  const known = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => t.kind !== "confirm" && !done.has(t.id) && !skip.has(t.id)
    && t.dependsOn.every((dep) => done.has(dep) || !known.has(dep)));
}

/** thrown 的不一定是 Error；顯示失敗原因時不能再丟例外 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function scheduleLanes(tasks: readonly TaskItem[], initiallyDone: ReadonlySet<string>, limit: number, hooks: LaneHooks): Promise<LaneResult> {
  const result: LaneResult = { done: new Set(initiallyDone) };
  const running = new Map<string, Promise<{ task: TaskItem; outcome: LaneOutcome }>>();
  // 車道的基礎設施例外（建立 worktree、合併、修補）一律轉成失敗：rejection 穿透 Promise.race 會讓排程中止，
  // 留下仍在執行的車道，之後的 rejection 也沒有人接
  const launch = (task: TaskItem) => {
    running.set(task.id, new Promise<LaneOutcome>((resolve) => resolve(hooks.start(task))).then((outcome) => ({ task, outcome }), (error): { task: TaskItem; outcome: LaneOutcome } => (
      { task, outcome: { kind: "failed", reason: errorMessage(error) } }
    )));
  };
  let stopped = false;
  // 第一個失敗是 result.failed；之後的失敗原因併進去，不要因為 ??= 而消失
  const fail = (task: TaskItem, reason: string, category?: string) => {
    stopped = true;
    if (!result.failed) result.failed = { task, reason, category };
    else result.failed.reason += `\n${task.id}：${reason}`;
  };
  for (;;) {
    if (!stopped) {
      for (const task of readyTasks(tasks, result.done, new Set(running.keys()))) {
        if (running.size >= limit) break;
        launch(task);
      }
    }
    if (running.size === 0) return result;
    const { task, outcome } = await Promise.race(running.values());
    running.delete(task.id);
    if (outcome.kind === "amend") {
      let resolution: AmendResolution;
      try {
        resolution = hooks.amend
          ? await hooks.amend(task, outcome.request)
          : { kind: "failed", reason: `${task.id} 提出修補請求，但這個流程不支援修補` };
      } catch (error) {
        resolution = { kind: "failed", reason: errorMessage(error) };
      }
      if (resolution === "retry") {
        if (!stopped) launch(task);
      } else if (resolution === "restart") {
        stopped = true;
        result.restart = true;
      } else if (resolution.kind === "paused") {
        stopped = true;
        result.paused ??= resolution.reason;
      } else {
        fail(task, resolution.reason, resolution.category);
      }
    } else if (outcome.kind === "failed") {
      fail(task, outcome.reason, outcome.category);
    } else if (outcome.kind === "paused") {
      stopped = true;
      result.paused ??= outcome.reason;
    } else {
      let merged: Awaited<ReturnType<LaneHooks["merge"]>>;
      try {
        merged = await hooks.merge(task);
      } catch (error) {
        merged = { kind: "failed", reason: errorMessage(error) };
      }
      if (merged === "merged") result.done.add(task.id);
      else if (merged === "redo") {
        if (!stopped) launch(task);
      } else {
        fail(task, merged.reason, merged.category);
      }
    }
  }
}
