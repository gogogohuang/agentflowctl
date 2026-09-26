import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentDef, RepoConfig } from "./schemas.js";

/**
 * `agentflowctl agent` 指令的設定編輯。
 * 直接操作 flow.config.json 的原始物件（不套預設值），寫回時只多出使用者指定的欄位。
 */
export type RawConfig = Record<string, unknown>;
type RawAgent = Record<string, unknown>;

export interface AgentPatch {
  adapter?: string;
  model?: string;
  extraArgs?: string[];
  command?: string[];
}

/** 每次編輯的結果：新的設定，以及連帶更新了哪些其他設定（給使用者看） */
export interface Edit {
  cfg: RawConfig;
  changes: string[];
}

/** 這些欄位的意義取決於 adapter，換 adapter 時要清掉 */
const ADAPTER_FIELDS = ["model", "extraArgs", "command"] as const;

const agentsOf = (cfg: RawConfig) => ({ ...((cfg.agents ?? {}) as Record<string, RawAgent>) });
const isDefined = (cfg: RawConfig, name: string) => name in agentsOf(cfg);

/** 只留下有值的欄位，驗證後回傳 */
function buildAgent(base: RawAgent, patch: AgentPatch): RawAgent {
  const next: RawAgent = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  const parsed = AgentDef.safeParse(next);
  if (!parsed.success) throw new Error(`agent 設定不合法：\n${z.prettifyError(parsed.error)}`);
  if (parsed.data.adapter === "command" && !parsed.data.command?.length) {
    throw new Error("command adapter 需要指令，請寫在 -- 後面，例如：-- aider --message {prompt}");
  }
  if (parsed.data.adapter !== "command" && parsed.data.command) throw new Error("只有 command adapter 可以設定 command");
  return next;
}

export function addAgent(cfg: RawConfig, name: string, def: AgentPatch & { adapter: string }): Edit {
  if (!/^[\w-]+$/.test(name)) throw new Error(`agent 名稱只能用英數字、底線與連字號：${name}`);
  if (isDefined(cfg, name)) throw new Error(`agent ${name} 已存在，要修改請用 agent set`);
  const { adapter, ...patch } = def;
  return { cfg: { ...cfg, agents: { ...agentsOf(cfg), [name]: buildAgent({ adapter }, patch) } }, changes: [] };
}

export function setAgent(cfg: RawConfig, name: string, patch: AgentPatch): Edit {
  if (!isDefined(cfg, name)) throw new Error(`未定義的 agent：${name}`);
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new Error("沒有要修改的欄位（--adapter、--model、--extra-arg 或 -- <command>）");
  }
  const agents = agentsOf(cfg);
  const base: RawAgent = { ...agents[name] };
  const changes: string[] = [];
  if (patch.adapter !== undefined && patch.adapter !== base.adapter) {
    const cleared = ADAPTER_FIELDS.filter((f) => base[f] !== undefined && patch[f] === undefined);
    for (const f of cleared) delete base[f];
    if (cleared.length) changes.push(`adapter 從 ${String(base.adapter)} 換成 ${patch.adapter}，已清掉舊的 ${cleared.join("、")}`);
  }
  return { cfg: { ...cfg, agents: { ...agents, [name]: buildAgent(base, patch) } }, changes };
}

export function removeAgent(cfg: RawConfig, name: string): Edit {
  if (!isDefined(cfg, name)) throw new Error(`未定義的 agent：${name}`);
  const agents = agentsOf(cfg);
  delete agents[name];
  const next: RawConfig = { ...cfg, agents };
  const changes: string[] = [];
  const cycle = cfg.cycle as string[] | undefined;
  if (cycle?.includes(name)) {
    const rest = cycle.filter((n) => n !== name);
    if (rest.length) {
      next.cycle = rest;
      changes.push(`已從參與的 agent 移除，現在是 ${rest.join("、")}`);
    } else {
      delete next.cycle;
      changes.push("參與的 agent 因此變空，已刪除 cycle，改回從 agents 自動偵測已安裝的 CLI");
    }
  }
  return { cfg: next, changes };
}

export function setCycle(cfg: RawConfig, names: string[]): Edit {
  if (!names.length) throw new Error("參與的 agent 至少要有一個");
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`參與的 agent 裡 ${dup} 重複了`);
  const missing = names.filter((n) => !isDefined(cfg, n));
  if (missing.length) throw new Error(`未定義的 agent：${missing.join("、")}（先用 agent add 新增）`);
  return { cfg: { ...cfg, cycle: names }, changes: [] };
}

export function readRawConfig(path: string): RawConfig {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
}

/** 先用 RepoConfig 驗證整份設定，通過才寫入 */
export function writeRawConfig(path: string, cfg: RawConfig): void {
  const parsed = RepoConfig.safeParse(cfg);
  if (!parsed.success) throw new Error(`設定不合法，未寫入：\n${z.prettifyError(parsed.error)}`);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}
