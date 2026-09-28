import { createHash } from "node:crypto";
import { z } from "zod";
import type { AcceptanceItem, RepoConfig, TaskItem } from "./schemas.js";

/** 對應 flow.config.json 的 planReviewLayers */
export type PlanReviewLayerOptions = RepoConfig["planReviewLayers"];

// 前面不能緊接路徑字元，中文標點與中文字後面的路徑才抓得到，URL 片段則不會被當成路徑
const FILE_TOKEN = /(?<![A-Za-z0-9_.@/-])((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+)/g;
const TASK_HEADING = /^(#{2,6}) (T-\d+)(?!\d)/;
const OVERVIEW_MAX_LINES = 120;
const EVIDENCE_MAX_LINES = 40;

export interface PlanReviewGroup {
  id: string;
  taskIds: string[];
  files: string[];
}

export type LayeredDecision = { layered: true; groups: PlanReviewGroup[] } | { layered: false; reason?: string };

const Verdict = z.enum(["approve", "changes_requested"]);

const ReviewedTask = z.object({
  fingerprint: z.string(),
  acceptance: z.array(z.string()),
  dependsOn: z.array(z.string()),
  verdict: Verdict,
});

export const PlanReviewed = z.object({
  overview: z.string(),
  tasks: z.record(z.string(), ReviewedTask),
});
export type PlanReviewed = z.infer<typeof PlanReviewed>;

export const PlanReviewCall = z.object({
  key: z.string(),
  reviewer: z.string(),
  verdict: Verdict,
  issueLines: z.array(z.string()),
  taskIds: z.array(z.string()).optional(),
});
export type PlanReviewCall = z.infer<typeof PlanReviewCall>;

export const PlanReviewRound = z.object({
  round: z.number().int(),
  planKey: z.string(),
  calls: z.array(PlanReviewCall),
});
export type PlanReviewRound = z.infer<typeof PlanReviewRound>;

/** reviewed 是上一次整輪完成的結果；round 是本輪進行中已成功的呼叫 */
export const PlanReviewState = z.object({
  version: z.literal(1),
  reviewed: PlanReviewed.optional(),
  round: PlanReviewRound.optional(),
});
export type PlanReviewState = z.infer<typeof PlanReviewState>;

function taskNum(id: string): number {
  return Number(id.slice(2));
}

export function extractFiles(description: string): string[] {
  const found = new Set<string>();
  for (const match of description.matchAll(FILE_TOKEN)) {
    const path = match[1];
    if (!path || path.startsWith(".flow/")) continue;
    found.add(path);
  }
  return [...found].sort();
}

function toGroup(members: TaskItem[], index: number): PlanReviewGroup {
  return {
    id: `G-${index + 1}`,
    taskIds: members.map((task) => task.id).sort((a, b) => taskNum(a) - taskNum(b)),
    files: [...new Set(members.flatMap((task) => extractFiles(task.description)))].sort(),
  };
}

export function taskClusters(tasks: TaskItem[]): PlanReviewGroup[] {
  const parent = new Map(tasks.map((task) => [task.id, task.id]));
  const find = (id: string): string => {
    const next = parent.get(id) ?? id;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const filesOf = new Map(tasks.map((task) => [task.id, extractFiles(task.description)]));
  const hasFiles = (id: string) => (filesOf.get(id) ?? []).length > 0;
  const owners = new Map<string, string>();
  for (const task of tasks) {
    for (const file of filesOf.get(task.id) ?? []) {
      const owner = owners.get(file);
      if (owner) unite(owner, task.id);
      else owners.set(file, task.id);
    }
  }
  for (const task of tasks) {
    if (hasFiles(task.id)) continue;
    // 只併入 dependsOn 順序中第一個抽得到路徑的目標，避免同時依附多個群時把它們合併起來
    for (const dep of task.dependsOn) {
      if (hasFiles(dep)) {
        unite(dep, task.id);
        break;
      }
    }
  }
  // 沒依附到路徑的檔名任務併成同一群，避免每個都自成一群、每輪多出一次呼叫
  const loose = tasks.filter((task) => !hasFiles(task.id) && find(task.id) === task.id);
  for (const task of loose.slice(1)) unite(loose[0]!.id, task.id);
  const buckets = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    const root = find(task.id);
    buckets.set(root, [...(buckets.get(root) ?? []), task]);
  }
  return [...buckets.values()]
    .map((members) => ({ members, order: Math.min(...members.map((task) => taskNum(task.id))) }))
    .sort((a, b) => a.order - b.order)
    .map((cluster, index) => toGroup(cluster.members, index));
}

export function planReviewGroups(tasks: TaskItem[], opts: PlanReviewLayerOptions): PlanReviewGroup[] {
  const clusters = taskClusters(tasks);
  // 群數不超過上限，也不讓每群平均少於 tasksPerGroup 個任務，避免拆出很多只有一兩個任務的呼叫
  const limit = Math.max(1, Math.min(opts.maxGroups, Math.floor(tasks.length / opts.tasksPerGroup)));
  if (clusters.length <= limit) return clusters;
  const packed: string[][] = [];
  clusters.forEach((cluster, index) => {
    const slot = Math.floor((index * limit) / clusters.length);
    packed[slot] = [...(packed[slot] ?? []), ...cluster.taskIds];
  });
  return packed.map((ids, index) => toGroup(tasks.filter((task) => ids.includes(task.id)), index));
}

export function missingTaskHeadings(planMd: string, taskIds: string[]): string[] {
  const found = new Set(planMd.split("\n").flatMap((line) => {
    const match = TASK_HEADING.exec(line);
    return match ? [match[2]!] : [];
  }));
  return taskIds.filter((id) => !found.has(id));
}

export function layeredReview(tasks: TaskItem[], planMd: string, opts: PlanReviewLayerOptions): LayeredDecision {
  if (!opts.enabled || tasks.length < opts.minTasks) return { layered: false };
  const clusters = taskClusters(tasks);
  if (clusters.length < 2) return { layered: false, reason: "任務要改的檔案互相重疊，只能分成一群" };
  const largest = Math.max(...clusters.map((cluster) => cluster.taskIds.length));
  // 一群占了大半時，分層只是多一次索引呼叫，也最容易漏掉那一群內部的問題
  if (largest * 3 > tasks.length * 2) {
    return { layered: false, reason: `最大的一群有 ${largest} 個任務，超過總數 ${tasks.length} 的三分之二` };
  }
  const groups = planReviewGroups(tasks, opts);
  if (groups.length < 2) return { layered: false, reason: `任務數 ${tasks.length} 不足以讓每群平均至少 ${opts.tasksPerGroup} 個` };
  // 沒有任務標題就切不出難度證據，群審查者會缺資料
  const missing = missingTaskHeadings(planMd, tasks.map((task) => task.id));
  if (missing.length) return { layered: false, reason: `plan.md 缺少 ${missing.join(", ")} 的「## T-<數字>」標題` };
  return { layered: true, groups };
}

export function planReviewIndex(tasks: TaskItem[]): string {
  return tasks.map((task) => {
    const deps = task.dependsOn.length ? task.dependsOn.join(", ") : "（無）";
    const description = task.description.trim().replace(/\s*\n\s*/g, " ");
    return `- ${task.id} ${task.title} | ${task.acceptance.join(", ")} | depends：${deps}\n  ${description}`;
  }).join("\n");
}

export function neighborTasks(tasks: TaskItem[], taskIds: string[]): TaskItem[] {
  const inGroup = new Set(taskIds);
  const linked = new Set<string>();
  for (const task of tasks) {
    if (inGroup.has(task.id)) for (const dep of task.dependsOn) linked.add(dep);
    else if (task.dependsOn.some((dep) => inGroup.has(dep))) linked.add(task.id);
  }
  return tasks.filter((task) => linked.has(task.id) && !inGroup.has(task.id));
}

export function groupReviewerCount(groupTasks: TaskItem[], quorum: number): number {
  return groupTasks.some((task) => task.complexity === "high") ? quorum : 1;
}

export function taskFingerprint(task: TaskItem, acceptance: AcceptanceItem[], planMd: string): string {
  const byId = new Map(acceptance.map((item) => [item.id, item.description]));
  return JSON.stringify({
    id: task.id,
    title: task.title,
    description: task.description,
    complexity: task.complexity ?? null,
    dependsOn: task.dependsOn,
    acceptance: task.acceptance.map((id) => ({ id, description: byId.get(id) ?? "" })),
    evidence: extractPlanEvidence(planMd, [task.id]),
  });
}

export function overviewKey(planMd: string): string {
  return planContentKey([planOverview(planMd)]);
}

export function readPlanReviewState(raw: string): PlanReviewState | undefined {
  try {
    const parsed = PlanReviewState.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function applyReviewVerdicts(
  prev: PlanReviewed | undefined,
  tasks: TaskItem[],
  acceptance: AcceptanceItem[],
  planMd: string,
  groupVerdicts: { taskIds: string[]; verdict: "approve" | "changes_requested" }[],
): PlanReviewed {
  const verdictOf = new Map<string, "approve" | "changes_requested">();
  for (const group of groupVerdicts) {
    for (const id of group.taskIds) {
      // 同一群有多位審查者時，任一位要求修改就算要求修改
      if (verdictOf.get(id) !== "changes_requested") verdictOf.set(id, group.verdict);
    }
  }
  const tasksState: PlanReviewed["tasks"] = {};
  for (const task of tasks) {
    const verdict = verdictOf.get(task.id) ?? prev?.tasks[task.id]?.verdict;
    if (!verdict) continue;
    tasksState[task.id] = {
      fingerprint: taskFingerprint(task, acceptance, planMd),
      acceptance: task.acceptance,
      dependsOn: task.dependsOn,
      verdict,
    };
  }
  return { overview: overviewKey(planMd), tasks: tasksState };
}

function sameList(a: string[], b: string[]): boolean {
  return a.join("\0") === b.join("\0");
}

export function dirtyTaskIds(prev: PlanReviewed | undefined, tasks: TaskItem[], acceptance: AcceptanceItem[], planMd: string): string[] {
  // 整體做法是每一群核准的前提，一變就全部重審
  if (!prev || prev.overview !== overviewKey(planMd)) return tasks.map((task) => task.id);
  const dirty = new Set<string>();
  for (const task of tasks) {
    const prior = prev.tasks[task.id];
    if (!prior || prior.verdict !== "approve" || prior.fingerprint !== taskFingerprint(task, acceptance, planMd)) dirty.add(task.id);
  }
  for (const task of tasks) {
    const prior = prev.tasks[task.id];
    if (!prior) continue;
    if (sameList(prior.acceptance, task.acceptance) && sameList(prior.dependsOn, task.dependsOn)) continue;
    dirty.add(task.id);
    for (const id of new Set([...prior.dependsOn, ...task.dependsOn])) dirty.add(id);
    for (const other of tasks) {
      if (other.dependsOn.includes(task.id)) dirty.add(other.id);
    }
  }
  return tasks.map((task) => task.id).filter((id) => dirty.has(id));
}

export function dirtyGroups(groups: PlanReviewGroup[], dirtyIds: string[]): PlanReviewGroup[] {
  const dirty = new Set(dirtyIds);
  return groups.filter((group) => group.taskIds.some((id) => dirty.has(id)));
}

export function planOverview(planMd: string): string {
  const lines = planMd.split("\n");
  const end = lines.findIndex((line) => TASK_HEADING.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).slice(0, OVERVIEW_MAX_LINES).join("\n").trim();
}

export function extractPlanEvidence(planMd: string, taskIds: string[]): string {
  const wanted = new Set(taskIds);
  const byId = new Map<string, string[]>();
  let current: { id: string; level: number } | null = null;
  for (const line of planMd.split("\n")) {
    const heading = /^(#{1,6}) /.exec(line);
    const task = TASK_HEADING.exec(line);
    if (task) current = { id: task[2]!, level: task[1]!.length };
    else if (heading && current && heading[1]!.length <= current.level) current = null;
    if (current && wanted.has(current.id)) byId.set(current.id, [...(byId.get(current.id) ?? []), line]);
  }
  return taskIds
    .filter((id) => byId.has(id))
    .map((id) => byId.get(id)!.slice(0, EVIDENCE_MAX_LINES).join("\n").trimEnd())
    .join("\n\n");
}

export function repliesForTasks(replies: string, taskIds: string[]): string {
  if (!replies.trim()) return "";
  const chunks = replies.split(/(?=^## )/m);
  return chunks.filter((chunk) => {
    const title = chunk.split("\n")[0] ?? "";
    return taskIds.some((id) => new RegExp(`^## ${id}(?!\\d)`).test(title));
  }).join("").trim();
}

export function reviewFingerprint(issueLines: string[]): string {
  return [...issueLines].sort().join("\n");
}

export function planContentKey(texts: string[]): string {
  return createHash("sha256").update(texts.join("\0")).digest("hex");
}

export function roundProgress(state: PlanReviewState | undefined, round: number, planKey: string): PlanReviewRound | undefined {
  const progress = state?.round;
  if (!progress || progress.round !== round || progress.planKey !== planKey) return undefined;
  return progress;
}
