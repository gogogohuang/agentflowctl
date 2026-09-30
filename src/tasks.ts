import type { AcceptanceItem, TaskItem } from "./schemas.js";

/** 一個任務最多做兩件事：對應的驗收條件超過這個數量就要再拆 */
export const MAX_TASK_ACCEPTANCE = 2;

/** 描述已明確放棄紅燈。新計畫必須把 tdd 標成 false；已定案的任務則仍寫測試，但不要求先失敗。 */
const RED_WAIVED = /不要求紅燈|不必紅燈|不需紅燈|無需紅燈|不用紅燈|略過紅燈|略過紅綠燈/;

export function descriptionWaivesRed(description: string): boolean {
  return RED_WAIVED.test(description);
}

/** 描述與 tdd 矛盾時退回計畫：寫明不要求紅燈就必須標 false。 */
export function validateTddFlag(tasks: TaskItem[]): string | undefined {
  const conflicts = tasks.filter((task) => task.tdd !== false && descriptionWaivesRed(task.description));
  if (!conflicts.length) return undefined;
  return conflicts
    .map((task) => `${task.id} 的描述寫明不要求紅燈，但 tdd 不是 false。這種任務在實作前就會通過，請改成 "tdd": false。`)
    .join("\n");
}

/** adaptive 的新計畫必須明確標註難度；舊 run 仍可讀取缺少欄位的 task。 */
export function validateTaskComplexity(tasks: TaskItem[], mode: "balanced" | "adaptive"): string | undefined {
  if (mode === "balanced") return undefined;
  const missing = tasks.filter((task) => !task.complexity).map((task) => task.id);
  return missing.length ? `任務缺少 complexity：${missing.join("、")}` : undefined;
}

/** 只取目前任務負責的驗收條件，避免每次實作都重讀整份清單。 */
export function taskAcceptance(task: TaskItem, acceptance: AcceptanceItem[]): AcceptanceItem[] {
  const byId = new Map(acceptance.map((item) => [item.id, item]));
  return task.acceptance.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`${task.id} 對應的驗收條件 ${id} 不存在`);
    return item;
  });
}

/**
 * 檢查任務清單並依相依關係排序（Kahn 演算法）。
 * 回傳排序後的任務，或回傳一段可以直接回饋給 Agent 的錯誤說明。
 */
export function orderTasks(tasks: TaskItem[], acceptanceIds: Set<string>): TaskItem[] | string {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`任務 id 重複：${t.id}`);
    ids.add(t.id);
  }
  const covered = new Set<string>();
  for (const t of tasks) {
    if (t.acceptance.length > MAX_TASK_ACCEPTANCE) {
      errors.push(`${t.id} 對應 ${t.acceptance.length} 條驗收條件，一個任務最多 ${MAX_TASK_ACCEPTANCE} 條，請拆成更小的任務`);
    }
    for (const d of t.dependsOn) if (!ids.has(d)) errors.push(`${t.id} 相依的 ${d} 不存在`);
    for (const a of t.acceptance) {
      if (!acceptanceIds.has(a)) errors.push(`${t.id} 對應的驗收條件 ${a} 不存在`);
      covered.add(a);
    }
  }
  for (const a of acceptanceIds) if (!covered.has(a)) errors.push(`驗收條件 ${a} 沒有任何任務負責`);
  if (errors.length) return errors.join("\n");

  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  const ordered: TaskItem[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const t of tasks) {
      if (!t.dependsOn.includes(id)) continue;
      const n = (indegree.get(t.id) ?? 0) - 1;
      indegree.set(t.id, n);
      if (n === 0) queue.push(t.id);
    }
  }
  if (ordered.length !== tasks.length) {
    const stuck = tasks.filter((t) => !ordered.includes(t)).map((t) => t.id);
    return `任務之間有循環相依：${stuck.join(", ")}`;
  }
  return ordered;
}

/**
 * 需要人確認的任務。confirmations.json 已寫出時以它為準（空陣列代表沒有）；
 * 還沒寫出時，從實作清單與計畫裡蒐集 kind 為 confirm 的任務。
 */
export function confirmationTasks(saved: TaskItem[] | undefined, ordered: TaskItem[], planned: TaskItem[]): TaskItem[] {
  if (saved) return saved;
  const seen = new Set<string>();
  const out: TaskItem[] = [];
  for (const task of [...ordered, ...planned]) {
    if (task.kind !== "confirm" || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/** 只列出待人確認的任務；沒有時回一句說明 */
export function confirmationLines(tasks: TaskItem[]): string[] {
  if (!tasks.length) return ["沒有需要人確認的任務"];
  const lines = ["待你確認"];
  for (const task of tasks) {
    lines.push(`  ${task.id} ${task.title}`);
    lines.push(`    ${task.description}`);
    lines.push(`    驗收：${task.acceptance.join("、")}`);
  }
  return lines;
}
