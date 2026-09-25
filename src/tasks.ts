import type { TaskItem } from "./schemas.js";

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
