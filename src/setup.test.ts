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
    // claude: 加入、名稱、model；codex: 加入、名稱、model；gemini 沒安裝不詢問；參與的 agent；確認
    const s = scripted(["", "", "", "", "", "", "", ""]);
    const edit = await runSetup({}, { ...s, detected: { claude: true, codex: true, gemini: false } });
    expect(edit?.cfg).toEqual({
      agents: { claude: { adapter: "claude" }, codex: { adapter: "codex" } },
      cycle: ["claude", "codex"],
    });
    expect(s.asked.some((q) => q.includes("gemini"))).toBe(false);
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
    const s = scripted(["y", "claude-strong", "opus", "n", "y", "", "", "gemini,claude-strong", "y"]);
    const edit = await runSetup({ tddSplit: false }, { ...s, detected: all });
    expect(edit?.cfg).toEqual({
      tddSplit: false,
      agents: { "claude-strong": { adapter: "claude", model: "opus" }, gemini: { adapter: "gemini" } },
      cycle: ["gemini", "claude-strong"],
    });
  });

  it("名稱不合法或重複時重問", async () => {
    const s = scripted(["y", "a b", "x", "", "y", "x", "y2", "", "n", "", "y"]);
    const edit = await runSetup({}, { ...s, detected: all });
    expect(Object.keys((edit?.cfg.agents ?? {}) as object)).toEqual(["x", "y2"]);
    expect(s.asked.filter((q) => q.includes("名稱")).length).toBe(4);
  });

  it("已存在的 agent 可以略過（仍會參與）或覆寫", async () => {
    const cfg = { agents: { claude: { adapter: "claude", model: "old" }, codex: { adapter: "codex", model: "o3" } } };
    // claude 已存在 → 不覆寫；codex 已存在 → 覆寫並改 model；gemini 不加入
    const s = scripted(["y", "", "n", "y", "", "y", "gpt-5", "n", "", "y"]);
    const edit = await runSetup(cfg, { ...s, detected: all });
    expect(edit?.cfg).toEqual({
      agents: { claude: { adapter: "claude", model: "old" }, codex: { adapter: "codex", model: "gpt-5" } },
      cycle: ["claude", "codex"],
    });
  });

  it("參與的 agent 不合法時重問", async () => {
    const s = scripted(["y", "", "", "n", "n", "claude,nobody", "claude,claude", "claude", "y"]);
    const edit = await runSetup({}, { ...s, detected: all });
    expect(edit?.cfg.cycle).toEqual(["claude"]);
  });

  it("一個都沒選或最後不確認時不變更", async () => {
    expect(await runSetup({}, { ...scripted(["n", "n", "n"]), detected: all })).toBeNull();
    expect(await runSetup({}, { ...scripted(["y", "", "", "n", "n", "", "n"]), detected: all })).toBeNull();
  });
});
