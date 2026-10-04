import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stageOfStep } from "./modelSelection.js";
import { agentflowctlDir, runDir, sharedRunDir } from "./paths.js";
import { FlowRun } from "./schemas.js";

const statePath = (id: string) => join(runDir(id), "state.json");
/** 檔名沿用舊版的 costs.jsonl，進行中的 run 升級後執行次數不會歸零 */
const usagePath = (id: string) => join(sharedRunDir(id), "costs.jsonl");

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
  mkdirSync(sharedRunDir(id), { recursive: true });
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

/** 逐行讀取 jsonl；寫到一半被中斷的殘行直接略過，不讓 status、insights 整個讀不出來 */
function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}

export function listUsage(id: string): UsageEntry[] {
  return readJsonl(usagePath(id));
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
export function totalUsage(entries: UsageEntry[]): UsageSummary {
  const acc = emptySummary();
  for (const e of entries) addSummary(acc, e);
  return acc;
}

export function summarizeUsage(entries: UsageEntry[], keyOf: (e: UsageEntry) => string): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {};
  for (const e of entries) addSummary(out[keyOf(e)] ??= emptySummary(), e);
  return out;
}

export const usageKeyAgent = (e: UsageEntry) => e.agent;
export const usageKeyStrength = (e: UsageEntry) => e.strength ?? "未知";
export const usageKeyStage = (e: UsageEntry) => stageOfStep(e.stage) ?? "其他";
export const usageKeyTask = (e: UsageEntry) => /^(T-\d+)-/.exec(e.stage)?.[1] ?? "非任務步驟";
const modelName = (e: UsageEntry) => e.model ?? "CLI 預設（名稱未知）";
export const usageKeyModelStage = (e: UsageEntry) => `${modelName(e)} / ${e.stage}`;
/** 跨 run 用：任務步驟換成步驟種類（T-1-code → taskCode），不同 run 的 task id 不互相合併 */
export const usageKeyModelStageKind = (e: UsageEntry) => `${modelName(e)} / ${stageOfStep(e.stage) ?? e.stage}`;

function groupUsage(id: string, keyOf: (e: UsageEntry) => string): Record<string, UsageSummary> {
  return summarizeUsage(listUsage(id), keyOf);
}

export const usageByAgent = (id: string) => groupUsage(id, usageKeyAgent);
export const usageByModelStage = (id: string) => groupUsage(id, usageKeyModelStage);
export const usageByStrength = (id: string) => groupUsage(id, usageKeyStrength);
export const usageByStage = (id: string) => groupUsage(id, usageKeyStage);
export const usageByTask = (id: string) => groupUsage(id, usageKeyTask);

/** 這個 run 已執行 agent 的次數（每次執行都會記一筆用量） */
export function agentRuns(id: string): number {
  return listUsage(id).length;
}

/** 已保留但還沒寫入用量的執行次數；只存在程序記憶體，以所屬 run 為單位（車道與所屬 run 共用） */
const reservations = new Map<string, number>();

/** 在 CLI 啟動前保留一次執行額度：已寫入的用量加上保留數達上限就回傳 false。判斷與遞增在同一個同步區段，平行呼叫不會同時通過 */
export function reserveAgentRun(id: string, max: number): boolean {
  const key = sharedRunDir(id);
  const held = reservations.get(key) ?? 0;
  if (agentRuns(id) + held >= max) return false;
  reservations.set(key, held + 1);
  return true;
}

export function releaseAgentRun(id: string): void {
  const key = sharedRunDir(id);
  const held = reservations.get(key) ?? 0;
  if (held <= 1) reservations.delete(key);
  else reservations.set(key, held - 1);
}

/** 只供測試使用：清掉程序內的保留，模擬新啟動的程序 */
export function resetAgentRunReservations(): void {
  reservations.clear();
}

/** 檢查第一次失敗、原樣重跑後通過（視為 flaky）；只 append */
export interface FlakyEntry {
  /** task＝任務驗證，final＝整體驗證 */
  scope: "task" | "final";
  check: string;
}

const flakyPath = (id: string) => join(sharedRunDir(id), "flaky.jsonl");

export function addFlaky(id: string, entry: FlakyEntry): void {
  mkdirSync(sharedRunDir(id), { recursive: true });
  appendFileSync(flakyPath(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function listFlaky(id: string): (FlakyEntry & { at: string })[] {
  return readJsonl(flakyPath(id));
}

const sideEffectsPath = (id: string) => join(sharedRunDir(id), "side-effects.json");

/** 測試或檢查指令執行後會改動工作樹的路徑（它們的副作用，不是 agent 的修改） */
export function listSideEffects(id: string): string[] {
  try {
    return JSON.parse(readFileSync(sideEffectsPath(id), "utf8")) as string[];
  } catch {
    return [];
  }
}

export function addSideEffects(id: string, paths: readonly string[]): string[] {
  const all = [...new Set([...listSideEffects(id), ...paths])];
  mkdirSync(sharedRunDir(id), { recursive: true });
  writeFileSync(sideEffectsPath(id), JSON.stringify(all));
  return all;
}

export interface Substitution {
  step: string;
  planned: string;
  actual: string;
  note?: string;
}

const subPath = (id: string) => join(sharedRunDir(id), "substitutions.jsonl");

export function addSubstitution(id: string, s: Substitution): void {
  mkdirSync(sharedRunDir(id), { recursive: true });
  appendFileSync(subPath(id), `${JSON.stringify({ at: new Date().toISOString(), ...s })}\n`);
}

export function listSubstitutions(id: string): (Substitution & { at: string })[] {
  return readJsonl(subPath(id));
}

export const RetryCategories = [
  "agent_error", "missing_artifact", "format_invalid", "handoff_invalid", "open_handoff",
  "review_changes", "arbitration_revise", "plan_tampered", "tests_not_written", "code_not_written", "tests_not_red", "tests_modified",
  "tests_not_green", "tests_invalid", "tests_deleted", "checks_weakened", "out_of_scope", "checks_failed", "merge_conflict", "merge_tests_failed", "amend_invalid",
] as const;
export type RetryCategory = (typeof RetryCategories)[number];

export interface RetryEntry {
  key: string;
  /** 重試時退回的階段 */
  backTo: string;
  category: RetryCategory;
  attempt: number;
  final: boolean;
}

const retryPath = (id: string) => join(sharedRunDir(id), "retries.jsonl");

/**
 * savedAt 是目前 state.json 的 updatedAt。上一筆同 key、同 attempt 的紀錄若晚於它，
 * 代表上次寫入重試後還沒存到 state 就中斷了，resume 重跑同一步時不再重複記一筆。
 */
export function addRetry(id: string, entry: RetryEntry, savedAt?: string): void {
  if (savedAt) {
    const last = listRetries(id).filter((r) => r.key === entry.key).at(-1);
    if (last && last.attempt === entry.attempt && last.at > savedAt) return;
  }
  mkdirSync(sharedRunDir(id), { recursive: true });
  appendFileSync(retryPath(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function listRetries(id: string): (RetryEntry & { at: string })[] {
  return readJsonl(retryPath(id));
}
