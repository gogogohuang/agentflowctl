import { AmendRequest, type AcceptanceItem, type TaskItem } from "./schemas.js";

/**
 * 修補請求的判斷：只看程式能驗證的事實（格式、目標是否已合併、次數、是否已套用），
 * 不碰檔案與 git。請求合不合理由修補任務之後的任務審查把關。
 */

export type AmendDecision =
  | { kind: "invalid"; reason: string }
  | { kind: "limit"; reason: string }
  | { kind: "applied" }
  | { kind: "apply"; target: string; task: TaskItem; tasks: TaskItem[]; acceptance: AcceptanceItem[] };

export interface AmendInput {
  /** .flow/amend-request.json 的原文 */
  raw: string;
  /** 提出請求的任務 id */
  requesterId: string;
  tasks: readonly TaskItem[];
  /** 已合併的任務 id */
  done: ReadonlySet<string>;
  acceptance: readonly AcceptanceItem[];
  /** FlowRun.amendments：各已合併任務被修補過幾次 */
  counts: Readonly<Record<string, number>>;
  max: number;
  /** 已用過的任務 id（含另存給人確認的任務） */
  usedIds: readonly string[];
}

const numberOf = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));

/** 下一個編號：同前綴的最大編號加一，沒有就從 1 開始 */
export function nextId(prefix: "T" | "AC", ids: readonly string[]): string {
  const max = ids.filter((id) => id.startsWith(`${prefix}-`)).reduce((m, id) => Math.max(m, numberOf(id)), 0);
  return `${prefix}-${max + 1}`;
}

const describeAmend = (req: AmendRequest) =>
  req.files.length ? `${req.reason}\n\n預計修改：${req.files.join("、")}` : req.reason;

export function decideAmend(input: AmendInput): AmendDecision {
  const invalid = (reason: string): AmendDecision => ({ kind: "invalid", reason });
  let json: unknown;
  try {
    json = JSON.parse(input.raw);
  } catch {
    return invalid("amend-request.json 不是合法的 JSON");
  }
  const parsed = AmendRequest.safeParse(json);
  if (!parsed.success) {
    return invalid(`amend-request.json 格式不正確：${parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join("；")}`);
  }
  const { target, reason, files, acceptance: reqAcceptance } = parsed.data;
  const requester = input.tasks.find((t) => t.id === input.requesterId);
  if (!requester) return invalid(`找不到提出請求的任務 ${input.requesterId}`);
  if (target === input.requesterId) return invalid("不能修補自己；請在這個任務內完成");
  if (!input.tasks.some((t) => t.id === target)) return invalid(`找不到任務 ${target}`);
  if (!input.done.has(target)) {
    return invalid(`${target} 還沒合併；尚未完成的任務請在它自己的任務內處理，或寫進 .flow/handoff-response.json 的 newIssues`);
  }
  const description = describeAmend(parsed.data);
  if (input.tasks.some((t) => t.kind === "amend" && t.amendOf === target && t.description === description && !input.done.has(t.id))) {
    return { kind: "applied" };
  }
  const used = input.counts[target] ?? 0;
  if (used >= input.max) return { kind: "limit", reason: `${target} 已被修補 ${used} 次，達到上限 ${input.max}` };

  const acceptance = [...input.acceptance];
  const acIds = reqAcceptance.map((text) => {
    const existing = acceptance.find((a) => a.description === text);
    if (existing) return existing.id;
    const id = nextId("AC", acceptance.map((a) => a.id));
    acceptance.push({ id, description: text });
    return id;
  });
  const id = nextId("T", [...input.usedIds, ...input.tasks.map((t) => t.id)]);
  const task: TaskItem = {
    id,
    title: `修補 ${target}：${(reason.split("\n")[0] ?? reason).slice(0, 40)}`,
    description,
    dependsOn: [target],
    acceptance: acIds,
    kind: "amend",
    amendOf: target,
  };
  const tasks = input.tasks.flatMap((t) => {
    if (t.id === input.requesterId) {
      const updated: TaskItem = { ...t, dependsOn: [...new Set([...(t.dependsOn ?? []), id])] };
      return [task, updated];
    }
    return [t];
  });
  return { kind: "apply", target, task, tasks, acceptance };
}
