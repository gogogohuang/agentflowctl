import type { AcceptanceItem, TaskItem } from "./schemas.js";

/** 一個任務最多對應這麼多條驗收條件：超過就要再拆（同一條驗收條件只能有一個實作任務負責，見 orderTasks） */
export const MAX_TASK_ACCEPTANCE = 3;

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
  const owners = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.acceptance.length > MAX_TASK_ACCEPTANCE) {
      errors.push(`${t.id} 對應 ${t.acceptance.length} 條驗收條件，一個任務最多 ${MAX_TASK_ACCEPTANCE} 條，請拆成更小的任務`);
    }
    for (const d of t.dependsOn) if (!ids.has(d)) errors.push(`${t.id} 相依的 ${d} 不存在`);
    for (const a of t.acceptance) {
      if (!acceptanceIds.has(a)) errors.push(`${t.id} 對應的驗收條件 ${a} 不存在`);
      covered.add(a);
      if (t.kind !== "confirm") owners.set(a, [...(owners.get(a) ?? []), t.id]);
    }
  }
  for (const [a, ids] of owners) {
    if (ids.length > 1) errors.push(`${a} 同時由 ${ids.join("、")} 負責，請合併成一個任務，不要用多個任務重複驗證同一條驗收條件`);
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

/**
 * 只列出待人確認的任務；沒有時回一句說明。
 * draft 代表計畫還沒通過首次驗證，清單是從未經 validatePlan 檢查的草稿蒐集來的，可能有項目最終不會定案。
 */
export function confirmationLines(tasks: TaskItem[], draft = false): string[] {
  if (!tasks.length) return ["沒有需要人確認的任務"];
  const lines = [`待你確認（不進實作）${draft ? "（計畫尚未定案，以下為草稿）" : ""}`];
  for (const task of tasks) {
    lines.push(`  ${task.id} ${task.title}`);
    lines.push(`    ${task.description}`);
    lines.push(`    驗收：${task.acceptance.join("、")}`);
  }
  return lines;
}

/**
 * 把人工確認的內容從自動流程的檔案中分出來：
 * 只由 confirm 任務負責的驗收條件、confirm 任務本身，以及計畫裡 `## T-n` 的段落。
 * 剩下的任務去掉對 confirm 任務的相依。沒有任務認領的條件照舊保留。
 */
export function splitHumanItems<A extends { id: string }>(
  tasks: TaskItem[],
  acceptance: A[],
  planMd: string,
): { tasks: TaskItem[]; confirm: TaskItem[]; acceptance: A[]; humanAcceptance: A[]; planMd: string; humanPlan: Record<string, string> } {
  const confirm = tasks.filter((t) => t.kind === "confirm");
  const confirmIds = new Set(confirm.map((t) => t.id));
  const implemented = new Set(tasks.filter((t) => t.kind !== "confirm").flatMap((t) => t.acceptance));
  const confirmAc = new Set(confirm.flatMap((t) => t.acceptance));
  const isHuman = (a: A) => confirmAc.has(a.id) && !implemented.has(a.id);
  const humanPlan: Record<string, string> = {};
  const kept: string[] = [];
  let skipping = false;
  for (const line of planMd.split("\n")) {
    const heading = /^## (T-\d+)\b/.exec(line);
    if (heading) {
      skipping = confirmIds.has(heading[1]!);
      if (skipping) humanPlan[heading[1]!] = "";
    } else if (/^## /.test(line)) skipping = false;
    if (skipping) {
      const id = Object.keys(humanPlan).at(-1)!;
      humanPlan[id] += `${line}\n`;
    } else kept.push(line);
  }
  return {
    tasks: tasks.filter((t) => t.kind !== "confirm").map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => !confirmIds.has(d)) })),
    confirm,
    acceptance: acceptance.filter((a) => !isHuman(a)),
    humanAcceptance: acceptance.filter(isHuman),
    planMd: kept.join("\n"),
    humanPlan,
  };
}

/** PR 描述用的核對清單：這些項目不進實作，交給審 PR 的人逐項勾選；沒有項目時回空字串 */
export function confirmationChecklist(tasks: TaskItem[], acceptance: { id: string; description: string }[] = [], plan: Record<string, string> = {}): string {
  if (!tasks.length) return "";
  const text = new Map(acceptance.map((item) => [item.id, item.description]));
  const items = tasks.map((task) => {
    const criteria = task.acceptance.map((id) => (text.has(id) ? `${id} ${text.get(id)}` : id));
    const notes = plan[task.id]?.replace(/^## .*\n/, "").trim();
    return `- [ ] **${task.id} ${task.title}**\n  ${task.description.replace(/\n+/g, "\n  ")}\n  驗收：${criteria.join("；")}${notes ? `\n  計畫備註：${notes.replace(/\n+/g, "\n  ")}` : ""}`;
  });
  return `## 需要人工確認\n\n以下項目無法由程式判定，沒有交給 agent 實作，請在合併前親自確認：\n\n${items.join("\n")}\n`;
}

/** 描述裡寫出的檔案路徑（含目錄與副檔名），例如 src/pages/x/Foo.tsx */
const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]+/g;

export function describedPaths(description: string): Set<string> {
  return new Set((description.match(PATH_TOKEN) ?? []).map((path) => path.replace(/^\.\//, "")));
}

/**
 * 找出目前任務動到、但只有後面任務的描述提到的檔案。
 * 這些檔案屬於後面的任務：先做掉會讓那個任務的紅燈不可能成立，審查也看不出是誰的工作。
 */
export function outOfScopeFiles(tasks: TaskItem[], index: number, changed: string[]): { file: string; owner: string }[] {
  const mine = describedPaths(tasks[index]?.description ?? "");
  const found: { file: string; owner: string }[] = [];
  for (const file of changed) {
    if (mine.has(file)) continue;
    const owner = tasks.slice(index + 1).find((task) => describedPaths(task.description).has(file));
    if (owner) found.push({ file, owner: owner.id });
  }
  return found;
}

export function outOfScopeMessage(found: { file: string; owner: string }[]): string {
  return `這些檔案是後面的任務負責的，不屬於這個任務，已還原你的變更：${found.map((item) => `${item.file}（${item.owner}）`).join("、")}。只改這個任務描述提到、或完成它必須動的檔案；若認為任務切分有誤，請寫進 .flow/handoff-response.json 的 newIssues，不要順手做掉。`;
}
