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
  inputTokens: number;
  outputTokens: number;
}

export function addUsage(id: string, entry: UsageEntry): void {
  mkdirSync(runDir(id), { recursive: true });
  appendFileSync(usagePath(id), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** 依 agent 加總 token 與執行次數，方便比較各家模型 */
export function usageByAgent(id: string): Record<string, { tokens: number; runs: number }> {
  const p = usagePath(id);
  const out: Record<string, { tokens: number; runs: number }> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as Partial<UsageEntry>;
    const key = e.agent ?? "?";
    const acc = (out[key] ??= { tokens: 0, runs: 0 });
    acc.tokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    acc.runs += 1;
  }
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
