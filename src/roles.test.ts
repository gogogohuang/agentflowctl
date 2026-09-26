import { describe, expect, it } from "vitest";
import { arbiterPanel, availableAgent, fixAgent, pick, planFixAgent, reviewers, shuffled, specAgent, taskAgents } from "./roles.js";

const three = ["claude", "codex", "gemini"];
const two = ["claude", "codex"];
const seeds = Array.from({ length: 200 }, (_, i) => `run-${i}`);

describe("隨機挑選", () => {
  it("同一個 seed 永遠得到同樣的結果，resume 時人選不會變", () => {
    for (const s of seeds) expect(shuffled(three, s)).toEqual(shuffled(three, s));
    expect(taskAgents(three, 4, true, "r")).toEqual(taskAgents(three, 4, true, "r"));
  });

  it("不依 cycle 的順序：不同 seed 會輪到每一家", () => {
    expect(new Set(seeds.map((s) => specAgent(three, s)))).toEqual(new Set(three));
    expect(new Set(seeds.map((s) => shuffled(three, s).join()))).toHaveProperty("size", 6);
  });

  it("pick 會跳過排除的 agent，單一 agent 時退回自己", () => {
    for (const s of seeds) expect(pick(three, s, ["claude", "codex"])).toBe("gemini");
    expect(pick(["claude"], "x", ["claude"])).toBe("claude");
  });
});

describe("角色規則", () => {
  it("每一輪任務每家各寫一次測試，換輪時也不會連續同一家；實作不是測試作者", () => {
    for (const s of seeds) {
      const tests = Array.from({ length: 9 }, (_, i) => taskAgents(three, i, true, s));
      for (let b = 0; b < 3; b++) expect(new Set(tests.slice(b * 3, b * 3 + 3).map((t) => t.tests))).toEqual(new Set(three));
      tests.forEach((t, i) => {
        expect(t.code).not.toBe(t.tests);
        if (i > 0) expect(t.tests).not.toBe(tests[i - 1]!.tests);
      });
    }
    expect(taskAgents(three, 0, false, "x")).toEqual({ tests: taskAgents(three, 0, true, "x").tests, code: taskAgents(three, 0, true, "x").tests });
  });

  it("reviewer 永遠不是最後的作者，quorum 會挑不同的人", () => {
    for (const s of seeds) {
      expect(reviewers(three, "codex", 1, s)).toHaveLength(1);
      expect(reviewers(three, "codex", 1, s)).not.toContain("codex");
      expect(reviewers(three, "codex", 2, s).sort()).toEqual(["claude", "gemini"]);
      expect(reviewers(three, "codex", 5, s).sort()).toEqual(["claude", "gemini"]);
    }
    expect(reviewers(two, "claude", 1, "x")).toEqual(["codex"]);
    expect(reviewers(two, "codex", 2, "x")).toEqual(["claude"]);
    expect(reviewers(["claude"], "claude", 1, "x")).toEqual(["claude"]);
  });

  it("review 後的 ring 修正者不是 reviewer；兩家時等同交回作者", () => {
    for (const s of seeds) {
      const fixer = fixAgent(three, { source: "review", strategy: "ring", lastWriter: "codex", lastReviewer: "gemini", seed: s });
      expect(fixer).not.toBe("gemini");
    }
    expect(fixAgent(two, { source: "review", strategy: "ring", lastWriter: "codex", lastReviewer: "claude", seed: "x" })).toBe("codex");
  });

  it("verify 失敗或 author 策略時交回作者修正", () => {
    expect(fixAgent(three, { source: "verify", strategy: "ring", lastWriter: "codex", lastReviewer: "gemini", seed: "x" })).toBe("codex");
    expect(fixAgent(three, { source: "review", strategy: "author", lastWriter: "codex", lastReviewer: "gemini", seed: "x" })).toBe("codex");
  });
});

describe("計畫的角色規則", () => {
  it("計畫修正者不是審查者，author 策略交回作者", () => {
    for (const s of seeds) {
      expect(planFixAgent(three, { strategy: "ring", planWriter: "claude", planReviewer: "codex", seed: s })).not.toBe("codex");
    }
    expect(planFixAgent(three, { strategy: "author", planWriter: "claude", planReviewer: "codex", seed: "x" })).toBe("claude");
    expect(planFixAgent(two, { strategy: "ring", planWriter: "claude", planReviewer: "codex", seed: "x" })).toBe("claude");
  });

  it("有第三方就由第三方仲裁；只有兩家時兩家都仲裁", () => {
    expect(arbiterPanel(three, "x", "claude", "codex")).toEqual(["gemini"]);
    expect(arbiterPanel(three, "x", "gemini", "claude")).toEqual(["codex"]);
    const four = [...three, "qwen"];
    expect(new Set(seeds.map((s) => arbiterPanel(four, s, "claude", "codex")[0]))).toEqual(new Set(["gemini", "qwen"]));
    expect(arbiterPanel(two, "x", "claude", "codex")).toEqual(["claude", "codex"]);
    expect(arbiterPanel(["claude"], "x", "claude", "claude")).toEqual(["claude"]);
  });
});

describe("額度用完時的代打", () => {
  it("原本的 agent 還有額度就用它，否則隨機找一位還有額度的；全部用完回傳 undefined", () => {
    expect(availableAgent(two, "codex", [], "x")).toBe("codex");
    expect(availableAgent(two, "codex", ["codex"], "x")).toBe("claude");
    expect(availableAgent(two, "codex", ["codex", "claude"], "x")).toBeUndefined();
    expect(availableAgent(three, "claude", ["claude", "codex"], "x")).toBe("gemini");
    for (const s of seeds) expect(availableAgent(three, "claude", ["claude"], s)).not.toBe("claude");
  });
});
