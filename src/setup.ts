import { addAgent, setAgent, setCycle, type Edit, type RawConfig } from "./agentConfig.js";
import { addModel, setModelMode } from "./modelConfig.js";
import { ModelStrength } from "./schemas.js";
import { ADAPTERS, type AdapterName } from "./agents/index.js";

/**
 * `agentflowctl agent setup` 的互動精靈。
 * 問答與偵測結果由外部注入，這裡只負責流程；所有修改都在記憶體裡完成，確認後才交給呼叫端寫入。
 */
/** 不需自訂指令就能加入的 adapter；新增 adapter 時會自動出現在精靈裡 */
export const SETUP_ADAPTERS = (Object.keys(ADAPTERS) as AdapterName[]).filter((a) => a !== "command");
/** adapter → 預設的 CLI 是否已安裝，依詢問順序排列 */
export type Detected = Record<string, boolean>;

export interface SetupDeps {
  /** 問一個問題，回傳使用者輸入的原始字串 */
  ask: (question: string) => Promise<string>;
  /** 各 adapter 預設的 CLI 是否已安裝 */
  detected: Detected;
  /** flow.config.json 已設定的 agent → CLI 是否可以執行；讀不到設定時可省略 */
  configured?: Record<string, boolean>;
  log: (line: string) => void;
}

/** 回傳要寫入的設定；使用者沒選任何 agent 或最後沒確認時回傳 null */
export async function runSetup(initial: RawConfig, deps: SetupDeps): Promise<Edit | null> {
  const { detected, log } = deps;
  const ask = async (q: string, def = "") => (await deps.ask(def ? `${q}（${def}）：` : `${q}：`)).trim() || def;
  const confirm = async (q: string, def: boolean) => {
    const a = (await deps.ask(`${q}（${def ? "Y/n" : "y/N"}）：`)).trim().toLowerCase();
    return a ? a.startsWith("y") : def;
  };

  let cfg = initial;
  const changes: string[] = [];
  const chosen: string[] = [];
  const existing = () => Object.keys((cfg.agents ?? {}) as object);

  const hasModels = (c: RawConfig, name: string) => !!(c.agents as Record<string, { models?: unknown[] }>)[name]?.models?.length;

  /** 問模型模式：balanced 不用登記模型；adaptive 逐一登記缺 models 的 agent，只寫設定、不送請求驗證 */
  async function chooseModelMode(start: RawConfig, notes: string[]): Promise<RawConfig> {
    let next = start;
    const stored = ((next.modelSelection ?? {}) as { mode?: string }).mode;
    for (;;) {
      const mode = (await ask("模型模式（balanced＝沿用各 agent 的 model，adaptive＝依階段自動選模）", stored ?? "balanced")).toLowerCase();
      if (mode !== "balanced" && mode !== "adaptive") {
        log("  請輸入 balanced 或 adaptive");
        continue;
      }
      if (mode === "balanced") {
        if (stored === "adaptive") {
          next = setModelMode(next, "balanced");
          notes.push("modelSelection.mode → balanced");
        }
        return next;
      }
      let tried = next;
      const lacking = (next.cycle as string[]).filter((n) => !hasModels(next, n));
      const empty: string[] = [];
      for (const name of lacking) {
        log(`${name} 沒有登記模型，adaptive 只看 models，請登記可用的模型與強度`);
        for (;;) {
          const line = (await ask(`  ${name} 模型（名稱 [強度 low|medium|high] [effort]，強度省略為 medium，effort 僅限 Claude Code 與 Codex，Enter 結束）`)).trim();
          if (!line) break;
          const [model, strength = "medium", effort, ...extra] = line.split(/\s+/);
          if (extra.length || !ModelStrength.safeParse(strength).success) {
            log("  格式是「名稱 強度 effort」（後兩項可省略），強度只能是 low、medium 或 high");
            continue;
          }
          try {
            tried = addModel(tried, name, model!, strength as "low" | "medium" | "high", effort);
            notes.push(`${name} 模型 ${model}（${strength}${effort ? `，effort ${effort}` : ""}）`);
          } catch (e) {
            log(`  ${(e as Error).message}`);
          }
        }
        if (!hasModels(tried, name)) empty.push(name);
      }
      if (empty.length) {
        log(`⚠️  ${empty.join("、")} 沒有登記任何模型，無法使用 adaptive；請重新選擇模式`);
        continue;
      }
      log("已寫入模型設定但未驗證；寫入後可執行 agentflowctl model check 確認帳號能否呼叫");
      return setModelMode(tried, "adaptive");
    }
  }

  const configured = Object.entries(deps.configured ?? {});
  if (configured.length) {
    const defs = (cfg.agents ?? {}) as Record<string, { adapter?: string }>;
    log("已設定的 agent：");
    for (const [name, ok] of configured) {
      log(`  ${ok ? "✅" : "⚠️ "} ${name}（${defs[name]?.adapter ?? "?"}${ok ? "" : "，找不到可執行的 CLI"}）`);
    }
  }

  const installed = Object.keys(detected).filter((a) => detected[a]);
  const missing = Object.keys(detected).filter((a) => !detected[a]);
  if (missing.length) log(`沒有偵測到：${missing.join("、")}（安裝後可重跑 agent setup）`);
  if (!installed.length) {
    log("沒有偵測到可加入的 agent CLI，設定沒有變更");
    log("需要自訂指令的 CLI 請改用 agent add <name> --adapter command -- <指令>");
    return null;
  }

  for (const adapter of installed) {
    log(`✅ ${adapter}`);
    if (!(await confirm(`  加入 ${adapter}？`, true))) continue;

    let name: string;
    for (;;) {
      name = await ask("  名稱", adapter);
      if (!/^[\w-]+$/.test(name)) log("  名稱只能用英數字、底線與連字號");
      else if (chosen.includes(name)) log(`  ${name} 這次已經用過了`);
      else break;
    }

    const isNew = !existing().includes(name);
    if (!isNew && !(await confirm(`  ${name} 已存在，要覆寫嗎？`, false))) {
      chosen.push(name);
      continue;
    }
    const model = (await ask("  model（Enter 不指定）")) || undefined;
    const effort = adapter === "claude" || adapter === "codex" ? (await ask("  effort（推理強度，例如 low、medium、high；Enter 不指定）")).trim() || undefined : undefined;
    const edit = isNew ? addAgent(cfg, name, { adapter, model, effort }) : setAgent(cfg, name, { adapter, model, effort });
    cfg = edit.cfg;
    changes.push(...edit.changes);
    chosen.push(name);
  }

  if (!chosen.length) {
    log("沒有選擇任何 agent，設定沒有變更");
    return null;
  }

  for (;;) {
    const list = (await ask("參與的 agent，用逗號分隔", chosen.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
    try {
      cfg = setCycle(cfg, list).cfg;
      break;
    } catch (e) {
      log(`  ${(e as Error).message}`);
    }
  }

  cfg = await chooseModelMode(cfg, changes);

  const agents = cfg.agents as Record<string, { adapter: string; model?: string; effort?: string }>;
  log("\n即將寫入：");
  for (const name of chosen) log(`  ${name.padEnd(14)} adapter=${agents[name]!.adapter}${agents[name]!.model ? ` model=${agents[name]!.model}` : ""}${agents[name]!.effort ? ` effort=${agents[name]!.effort}` : ""}`);
  log(`  參與的 agent：${(cfg.cycle as string[]).join("、")}`);
  log("  需要自訂指令的 CLI 請改用 agent add <name> --adapter command -- <指令>");
  if (!(await confirm("寫入 flow.config.json？", true))) {
    log("已取消，設定沒有變更");
    return null;
  }
  return { cfg, changes };
}
