import type { TaskItem } from "./schemas.js";

/**
 * 平行任務的排程：沒有相依關係（或相依的任務都已合併）的任務各占一條車道同時執行，
 * 車道跑完後依完成順序、一次一個地合併回 run 的分支，合併後才解鎖依賴它的任務。
 * 這裡只管排程，不認得 git 或 agent，車道怎麼跑、怎麼合併由呼叫端提供。
 */

export type LaneOutcome =
  | { kind: "done" }
  | { kind: "failed"; reason: string; category?: string }
  | { kind: "paused"; reason: string };

export interface LaneHooks {
  /** 讓這個任務在自己的車道跑到完成（或失敗、暫停）；已有進度的車道要接著跑 */
  start(task: TaskItem): Promise<LaneOutcome>;
  /** 把完成的車道合併回 run 的分支；衝突時回傳 "redo"，排程會讓同一個任務重跑；衝突重試達上限則回報失敗 */
  merge(task: TaskItem): Promise<"merged" | "redo" | { kind: "failed"; reason: string; category?: string }>;
}

export interface LaneResult {
  /** 已合併的任務（含起始就算完成的） */
  done: Set<string>;
  failed?: { task: TaskItem; reason: string; category?: string };
  paused?: string;
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

export async function scheduleLanes(tasks: readonly TaskItem[], initiallyDone: ReadonlySet<string>, limit: number, hooks: LaneHooks): Promise<LaneResult> {
  const result: LaneResult = { done: new Set(initiallyDone) };
  const running = new Map<string, Promise<{ task: TaskItem; outcome: LaneOutcome }>>();
  const launch = (task: TaskItem) => {
    running.set(task.id, hooks.start(task).then((outcome) => ({ task, outcome })));
  };
  let stopped = false;
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
    if (outcome.kind === "failed") {
      stopped = true;
      result.failed ??= { task, reason: outcome.reason, category: outcome.category };
    } else if (outcome.kind === "paused") {
      stopped = true;
      result.paused ??= outcome.reason;
    } else {
      const merged = await hooks.merge(task);
      if (merged === "merged") result.done.add(task.id);
      else if (merged === "redo") {
        if (!stopped) launch(task);
      } else {
        stopped = true;
        result.failed ??= { task, reason: merged.reason, category: merged.category };
      }
    }
  }
}
