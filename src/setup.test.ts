import { describe, expect, it } from "vitest";
import { runSetup, type Detected } from "./setup.js";

/** 依序回答問題；答案用完還被問就報錯，避免測試卡住 */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const ask = async (q: string) => {
    asked.push(q);
    if (!answers.length) throw new Error(`沒有準備答案：${q}`);
    return answers.shift()!;
  };
  return { ask, asked, log: () => {} };
}

const all: Detected = { claude: true, codex: true, gemini: true };

describe("runSetup", () => {
  it("全部按 Enter：只詢問已安裝的，參與的 agent 依加入順序", async () => {
    // claude: 加入、名稱、model、effort；codex: 同上；gemini 沒安裝不詢問；參與的 agent；模型模式；確認
    const s = scripted(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
    const edit = await runSetup({}, { ...s, detected: { claude: true, codex: true, gemini: false } });
    expect(edit?.cfg).toEqual({
      agents: { claude: { adapter: "claude" }, codex: { adapter: "codex" } },
      cycle: ["claude", "codex"],
    });
    expect(s.asked.some((q) => q.includes("gemini"))).toBe(false);
  });

  it("claude 與 codex 會問 effort，gemini 不問", async () => {
    const s = scripted(["y", "", "", "high", "", "y", "", "", "", "", "y", "", "", "", "", "", "y"]);
    const edit = await runSetup({}, { ...s, detected: all });
    expect(edit?.cfg.agents).toEqual({ claude: { adapter: "claude", effort: "high" }, codex: { adapter: "codex" }, gemini: { adapter: "gemini" } });
    expect(s.asked.filter((q) => q.startsWith("  effort")).length).toBe(2);
  });

  it("可在加入 agent 時先登記模型與強度，之後選 adaptive 不再追問", async () => {
    // claude：加入、名稱、model、effort、登記 sonnet／opus（含 effort）後 Enter；參與的 agent；模式 adaptive；確認
    const s = scripted(["y", "", "", "", "sonnet low low", "opus high high", "", "", "adaptive", "y"]);
    const edit = await runSetup({}, { ...s, detected: { claude: true } });
    const agents = edit?.cfg.agents as Record<string, { models: unknown }>;
    expect(agents.claude!.models).toEqual([
      { name: "sonnet", strength: "low", effort: "low" },
      { name: "opus", strength: "high", effort: "high" },
    ]);
    expect((edit?.cfg.modelSelection as { mode: string }).mode).toBe("adaptive");
    expect(s.asked.filter((q) => q.includes("模型（")).length).toBe(0);
  });

  it("先登記時格式不合法會重問，同名同強度會被拒絕", async () => {
    const lines: string[] = [];
    const s = scripted(["y", "", "", "", "sonnet ultra", "sonnet", "sonnet medium", "", "", "", "y"]);
    const edit = await runSetup({}, { ...s, log: (l) => lines.push(l), detected: { claude: true } });
    expect((edit?.cfg.agents as Record<string, { models: unknown }>).claude!.models).toEqual([{ name: "sonnet", strength: "medium" }]);
    expect(lines.join("\n")).toContain("強度只能是");
    expect(lines.join("\n")).toContain("重複");
  });

  it("一個 CLI 都沒偵測到時不詢問、不變更", async () => {
    const s = scripted([]);
    expect(await runSetup({}, { ...s, detected: { claude: false, codex: false, gemini: false } })).toBeNull();
    expect(s.asked).toEqual([]);
  });

  it("先列出已設定的 agent 與是否可以執行", async () => {
    const lines: string[] = [];
    const cfg = { agents: { mine: { adapter: "claude" }, old: { adapter: "gemini" } } };
    await runSetup(cfg, { ...scripted([]), log: (l) => lines.push(l), detected: {}, configured: { mine: true, old: false } });
    expect(lines.slice(0, 3)).toEqual(["已設定的 agent：", "  ✅ mine（claude）", "  ⚠️  old（gemini，找不到可執行的 CLI）"]);
  });

  it("可自訂名稱、model 與參與的 agent，保留其他設定", async () => {
    const s = scripted(["y", "claude-strong", "opus", "high", "", "n", "y", "", "", "", "gemini,claude-strong", "", "y"]);
    const edit = await runSetup({ tddSplit: false }, { ...s, detected: all });
    expect(edit?.cfg).toEqual({
      tddSplit: false,
      agents: { "claude-strong": { adapter: "claude", model: "opus", effort: "high" }, gemini: { adapter: "gemini" } },
      cycle: ["gemini", "claude-strong"],
    });
  });

  it("名稱不合法或重複時重問", async () => {
    const s = scripted(["y", "a b", "x", "", "", "", "y", "x", "y2", "", "", "", "n", "", "", "y"]);
    const edit = await runSetup({}, { ...s, detected: all });
    expect(Object.keys((edit?.cfg.agents ?? {}) as object)).toEqual(["x", "y2"]);
    expect(s.asked.filter((q) => q.startsWith("  名稱")).length).toBe(4);
  });

  it("已存在的 agent 可以略過（仍會參與）或覆寫", async () => {
    const cfg = { agents: { claude: { adapter: "claude", model: "old" }, codex: { adapter: "codex", model: "o3" } } };
    // claude 已存在 → 不覆寫；codex 已存在 → 覆寫並改 model；gemini 不加入
    const s = scripted(["y", "", "n", "y", "", "y", "gpt-5", "xhigh", "", "n", "", "", "y"]);
    const edit = await runSetup(cfg, { ...s, detected: all });
    expect(edit?.cfg).toEqual({
      agents: { claude: { adapter: "claude", model: "old" }, codex: { adapter: "codex", model: "gpt-5", effort: "xhigh" } },
      cycle: ["claude", "codex"],
    });
  });

  it("參與的 agent 不合法時重問", async () => {
    const s = scripted(["y", "", "", "", "", "n", "n", "claude,nobody", "claude,claude", "claude", "", "y"]);
    const edit = await runSetup({}, { ...s, detected: all });
    expect(edit?.cfg.cycle).toEqual(["claude"]);
  });

  it("一個都沒選或最後不確認時不變更", async () => {
    expect(await runSetup({}, { ...scripted(["n", "n", "n"]), detected: all })).toBeNull();
    expect(await runSetup({}, { ...scripted(["y", "", "", "", "", "n", "n", "", "", "n"]), detected: all })).toBeNull();
  });

  it("模型模式預設 balanced：沒設定過就不寫 modelSelection", async () => {
    const s = scripted(["", "", "", "", "", "", "", ""]);
    const edit = await runSetup({}, { ...s, detected: { claude: true } });
    expect(edit?.cfg.modelSelection).toBeUndefined();
    expect(s.asked.some((q) => q.includes("模型模式") && q.includes("balanced"))).toBe(true);
  });

  it("目前是 adaptive 時改選 balanced：寫回 balanced", async () => {
    const s = scripted(["", "", "", "", "", "", "balanced", ""]);
    const edit = await runSetup({ modelSelection: { mode: "adaptive" } }, { ...s, detected: { claude: true } });
    expect((edit?.cfg.modelSelection as { mode: string }).mode).toBe("balanced");
  });

  it("目前是 adaptive 時預設沿用：逐一登記缺 models 的 agent", async () => {
    // claude: 加入、名稱、model、effort；參與的 agent；模式（Enter＝沿用 adaptive）；登記 sonnet、opus，Enter 結束；確認
    const s = scripted(["", "", "", "", "", "", "", "sonnet medium", "opus high", "", ""]);
    const edit = await runSetup({ modelSelection: { mode: "adaptive" } }, { ...s, detected: { claude: true } });
    expect((edit?.cfg.modelSelection as { mode: string }).mode).toBe("adaptive");
    expect((edit?.cfg.agents as Record<string, { models: unknown }>).claude!.models).toEqual([
      { name: "sonnet", strength: "medium" },
      { name: "opus", strength: "high" },
    ]);
  });

  it("選 adaptive：強度省略視為 medium，強度不合法時重問，已有 models 的 agent 不再問", async () => {
    const cfg = { agents: { codex: { adapter: "codex", models: [{ name: "o3", strength: "high" }] } } };
    // claude 加入；codex 沿用；參與的 agent；模式 adaptive；claude 先給不合法強度再給正確的；確認
    const s = scripted(["", "", "", "", "", "n", "claude,codex", "adaptive", "sonnet ultra", "sonnet", "", ""]);
    const edit = await runSetup(cfg, { ...s, detected: { claude: true, codex: true } });
    const agents = edit?.cfg.agents as Record<string, { models: unknown }>;
    expect(agents.claude!.models).toEqual([{ name: "sonnet", strength: "medium" }]);
    expect(agents.codex!.models).toEqual([{ name: "o3", strength: "high" }]);
    expect(s.asked.filter((q) => q.includes("codex") && q.includes("模型")).length).toBe(0);
  });

  it("選 adaptive 但某個 agent 一個模型都沒登記：說明後回到模式選擇", async () => {
    const lines: string[] = [];
    // 模式 adaptive → claude 直接 Enter 結束 → 回到模式，改選 balanced → 確認
    const s = scripted(["", "", "", "", "", "", "adaptive", "", "balanced", ""]);
    const edit = await runSetup({}, { ...s, log: (l) => lines.push(l), detected: { claude: true } });
    expect(edit?.cfg.modelSelection).toBeUndefined();
    expect(lines.join("\n")).toContain("claude");
    expect(lines.join("\n")).toContain("沒有登記");
  });

  it("模式輸入不合法時重問", async () => {
    const s = scripted(["", "", "", "", "", "", "fast", "balanced", ""]);
    const edit = await runSetup({}, { ...s, detected: { claude: true } });
    expect(edit).not.toBeNull();
    expect(s.asked.filter((q) => q.includes("模型模式")).length).toBe(2);
  });
});
