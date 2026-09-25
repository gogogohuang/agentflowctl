import { describe, expect, it } from "vitest";
import { fixAgent, nextAfter, reviewers, taskAgents } from "./roles.js";

const three = ["claude", "codex", "gemini"];
const two = ["claude", "codex"];

describe("輪替規則", () => {
  it("nextAfter 會跳過排除的 agent，單一 agent 時退回自己", () => {
    expect(nextAfter(three, "claude")).toBe("codex");
    expect(nextAfter(three, "gemini")).toBe("claude");
    expect(nextAfter(three, "claude", ["codex"])).toBe("gemini");
    expect(nextAfter(["claude"], "claude", ["claude"])).toBe("claude");
  });

  it("任務依序輪替，測試與實作由不同 agent 負責", () => {
    expect(taskAgents(three, 0, true)).toEqual({ tests: "claude", code: "codex" });
    expect(taskAgents(three, 1, true)).toEqual({ tests: "codex", code: "gemini" });
    expect(taskAgents(three, 2, true)).toEqual({ tests: "gemini", code: "claude" });
    expect(taskAgents(three, 0, false)).toEqual({ tests: "claude", code: "claude" });
  });

  it("reviewer 永遠不是最後的作者，quorum 會挑不同的人", () => {
    expect(reviewers(three, "codex", 1)).toEqual(["gemini"]);
    expect(reviewers(three, "codex", 2)).toEqual(["gemini", "claude"]);
    expect(reviewers(three, "codex", 5)).toEqual(["gemini", "claude"]);
    expect(reviewers(two, "claude", 1)).toEqual(["codex"]);
    expect(reviewers(["claude"], "claude", 1)).toEqual(["claude"]);
  });

  it("三家輪替時，實作、審查、修正會一直換人", () => {
    // codex 寫完 → gemini 審查 → claude 修正 → codex 審查 → gemini 修正 → claude 審查
    let writer = "codex";
    const sequence: string[] = [];
    for (let round = 0; round < 3; round++) {
      const reviewer = reviewers(three, writer, 1)[0]!;
      const fixer = fixAgent(three, { source: "review", strategy: "ring", lastWriter: writer, lastReviewer: reviewer });
      sequence.push(`${reviewer}審→${fixer}修`);
      expect(reviewer).not.toBe(writer);
      expect(fixer).not.toBe(reviewer);
      writer = fixer;
    }
    expect(sequence).toEqual(["gemini審→claude修", "codex審→gemini修", "claude審→codex修"]);
  });

  it("verify 失敗或 author 策略時交回作者修正", () => {
    expect(fixAgent(three, { source: "verify", strategy: "ring", lastWriter: "codex", lastReviewer: "gemini" })).toBe("codex");
    expect(fixAgent(three, { source: "review", strategy: "author", lastWriter: "codex", lastReviewer: "gemini" })).toBe("codex");
  });
});

import { arbiterPanel, planFixAgent } from "./roles.js";

describe("計畫的輪替規則", () => {
  it("計畫修正輪到審查者的下一位，author 策略交回作者", () => {
    expect(planFixAgent(three, { strategy: "ring", planWriter: "claude", planReviewer: "codex" })).toBe("gemini");
    expect(planFixAgent(three, { strategy: "author", planWriter: "claude", planReviewer: "codex" })).toBe("claude");
  });

  it("有第三方就由第三方仲裁；只有兩家時兩家都仲裁", () => {
    expect(arbiterPanel(three, "claude", "codex")).toEqual(["gemini"]);
    expect(arbiterPanel(three, "gemini", "claude")).toEqual(["codex"]);
    expect(arbiterPanel(two, "claude", "codex")).toEqual(["claude", "codex"]);
    expect(arbiterPanel(["claude"], "claude", "claude")).toEqual(["claude"]);
  });

  it("兩家時 ring 修正策略等同交回作者", () => {
    expect(planFixAgent(two, { strategy: "ring", planWriter: "claude", planReviewer: "codex" })).toBe("claude");
    expect(fixAgent(two, { source: "review", strategy: "ring", lastWriter: "codex", lastReviewer: "claude" })).toBe("codex");
    expect(reviewers(two, "codex", 2)).toEqual(["claude"]);
  });
});

import { availableAgent } from "./roles.js";

describe("額度用完時的代打", () => {
  it("原本的 agent 還有額度就用它，否則找下一位；全部用完回傳 undefined", () => {
    expect(availableAgent(two, "codex", [])).toBe("codex");
    expect(availableAgent(two, "codex", ["codex"])).toBe("claude");
    expect(availableAgent(two, "codex", ["codex", "claude"])).toBeUndefined();
    expect(availableAgent(three, "claude", ["claude", "codex"])).toBe("gemini");
  });
});
