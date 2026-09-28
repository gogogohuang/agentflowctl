import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stageOfStep } from "./modelSelection.js";
import { agentflowctlDir, runDir } from "./paths.js";
import { FlowRun } from "./schemas.js";

const statePath = (id: string) => join(runDir(id), "state.json");
/** 檔名沿用舊版的 costs.jsonl，進行中的 run 升級後執行次數不會歸零 */
const usagePath = (id: string) => join(runDir(id), "costs.jsonl");

/** 先寫暫存檔再 rename，確保 state.json 不會因中斷而只寫一半 */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function saveRun(run: FlowRun): FlowRun {
  const next = FlowRun.parse({ ...run, updatedAt: new Date().toISOString() });
  writeAtomic(statePath(next.id), JSON.stringify(next, null, 2));
  return next;
}

export function getRun(id: string): FlowRun | undefined {
  const p = statePath(id);
  return existsSync(p) ? FlowRun.parse(JSON.parse(readFileSync(p, "utf8"))) : undefined;
}

export function listRuns(): FlowRun[] {
  const dir = join(agentflowctlDir(), "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(getRun)
    .filter((r): r is FlowRun => r !== undefined)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 用量只 append、不改寫，多個寫入者同時寫也不會互相覆蓋 */
export interface UsageEntry {
  stage: string;
  agent: string;
  inputTokens?: number;
  outputTokens?: number;
  /** inputTokens 中讀取 cache 的部分；舊紀錄與不回報 cache 的 CLI 沒有這個欄位 */
  cacheReadTokens?: number;
  /** inputTokens 中寫入 cache 的部分 */
  cacheWriteTokens?: number;
  usageReported?: boolean;
  model?: string;
  resolvedModel?: string;
  strength?: "low" | "medium" | "high";
  targetStrength?: "low" | "medium" | "high";
}

export function addUsage(id: string, entry: UsageEntry): void {
  mkdirSync(runDir(id), { recursive: true });
  appendFileSync(usagePath(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export interface UsageSummary {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** 已含在 inputTokens 內 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  runs: number;
  reportedRuns: number;
  unreportedRuns: number;
  legacyRuns: number;
  /** 舊紀錄的原始數字，只供查閱，不算進合計與占比 */
  legacyTokens: number;
}

const emptySummary = (): UsageSummary => ({ tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 0, reportedRuns: 0, unreportedRuns: 0, legacyRuns: 0, legacyTokens: 0 });

export function listUsage(id: string): UsageEntry[] {
  const p = usagePath(id);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as UsageEntry) : [];
}

function addSummary(acc: UsageSummary, e: UsageEntry): void {
  acc.runs += 1;
  if (e.usageReported === true && typeof e.inputTokens === "number" && typeof e.outputTokens === "number") {
    acc.reportedRuns += 1;
    acc.inputTokens += e.inputTokens ?? 0;
    acc.outputTokens += e.outputTokens ?? 0;
    acc.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    acc.cacheReadTokens += e.cacheReadTokens ?? 0;
    acc.cacheWriteTokens += e.cacheWriteTokens ?? 0;
  } else if (e.usageReported === false || e.usageReported === true) acc.unreportedRuns += 1;
  else {
    acc.legacyRuns += 1;
    acc.legacyTokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
  }
}

/** 只加總明確回報的 token，舊資料的 0 不視為已回報。 */
function groupUsage(id: string, keyOf: (e: UsageEntry) => string): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {};
  for (const e of listUsage(id)) addSummary(out[keyOf(e)] ??= emptySummary(), e);
  return out;
}

export const usageByAgent = (id: string) => groupUsage(id, (e) => e.agent);
export const usageByModelStage = (id: string) => groupUsage(id, (e) => `${e.model ?? "CLI 預設（名稱未知）"} / ${e.stage}`);
export const usageByStrength = (id: string) => groupUsage(id, (e) => e.strength ?? "未知");
/** 依階段鍵加總（所有任務的同一步合在一起）；認不得的步驟歸為「其他」。 */
export const usageByStage = (id: string) => groupUsage(id, (e) => stageOfStep(e.stage) ?? "其他");
/** 依任務加總寫測試、實作、任務審查與任務修正；規格、計畫與整體階段歸為「非任務步驟」。 */
export const usageByTask = (id: string) => groupUsage(id, (e) => /^(T-\d+)-/.exec(e.stage)?.[1] ?? "非任務步驟");

/** 這個 run 已執行 agent 的次數（每次執行都會記一筆用量） */
export function agentRuns(id: string): number {
  const p = usagePath(id);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0;
}

export interface Substitution {
  step: string;
  planned: string;
  actual: string;
  note?: string;
}

const subPath = (id: string) => join(runDir(id), "substitutions.jsonl");

export function addSubstitution(id: string, s: Substitution): void {
  mkdirSync(runDir(id), { recursive: true });
  appendFileSync(subPath(id), `${JSON.stringify({ at: new Date().toISOString(), ...s })}\n`);
}

export function listSubstitutions(id: string): (Substitution & { at: string })[] {
  const p = subPath(id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Substitution & { at: string });
}

export const RetryCategories = [
  "agent_error", "missing_artifact", "format_invalid", "handoff_invalid", "open_handoff",
  "review_changes", "plan_tampered", "tests_not_written", "tests_not_red", "tests_modified",
  "tests_not_green", "tests_deleted", "checks_failed",
] as const;
export type RetryCategory = (typeof RetryCategories)[number];

export interface RetryEntry {
  key: string;
  stage: string;
  category: RetryCategory;
  attempt: number;
  final: boolean;
}

const retryPath = (id: string) => join(runDir(id), "retries.jsonl");

export function addRetry(id: string, entry: RetryEntry): void {
  mkdirSync(runDir(id), { recursive: true });
  appendFileSync(retryPath(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function listRetries(id: string): (RetryEntry & { at: string })[] {
  const p = retryPath(id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RetryEntry & { at: string });
}
