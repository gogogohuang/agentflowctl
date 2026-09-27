import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  runs: number;
  reportedRuns: number;
  unreportedRuns: number;
  legacyRuns: number;
}

const emptySummary = (): UsageSummary => ({ tokens: 0, inputTokens: 0, outputTokens: 0, runs: 0, reportedRuns: 0, unreportedRuns: 0, legacyRuns: 0 });

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
  } else if (e.usageReported === false || e.usageReported === true) acc.unreportedRuns += 1;
  else acc.legacyRuns += 1;
}

/** 只加總明確回報的 token，舊資料的 0 不視為已回報。 */
export function usageByAgent(id: string): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {};
  for (const e of listUsage(id)) addSummary(out[e.agent] ??= emptySummary(), e);
  return out;
}

/** 依模型與 LLM 步驟提供相同的統計語意。 */
export function usageByModelStage(id: string): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {};
  for (const e of listUsage(id)) addSummary(out[`${e.model ?? "CLI 預設（名稱未知）"} / ${e.stage}`] ??= emptySummary(), e);
  return out;
}

export function usageByStrength(id: string): Record<string, UsageSummary> {
  const out: Record<string, UsageSummary> = {};
  for (const e of listUsage(id)) addSummary(out[e.strength ?? "未知"] ??= emptySummary(), e);
  return out;
}

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
