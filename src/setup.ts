import { addAgent, setAgent, setCycle, type Edit, type RawConfig } from "./agentConfig.js";
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
    const edit = isNew ? addAgent(cfg, name, { adapter, model }) : setAgent(cfg, name, { adapter, model });
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

  const agents = cfg.agents as Record<string, { adapter: string; model?: string }>;
  log("\n即將寫入：");
  for (const name of chosen) log(`  ${name.padEnd(14)} adapter=${agents[name]!.adapter}${agents[name]!.model ? ` model=${agents[name]!.model}` : ""}`);
  log(`  參與的 agent：${(cfg.cycle as string[]).join("、")}`);
  log("  需要自訂指令的 CLI 請改用 agent add <name> --adapter command -- <指令>");
  if (!(await confirm("寫入 flow.config.json？", true))) {
    log("已取消，設定沒有變更");
    return null;
  }
  return { cfg, changes };
}
