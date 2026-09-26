import { describe, expect, it } from "vitest";
import { arbitrationDecision } from "./arbitration.js";
import { ArbiterResult } from "./schemas.js";

describe("計畫仲裁結果", () => {
  it("兩家都反對時交回修訂，即使已達重試上限也重新審查", () => {
    expect(arbitrationDecision(["changes_requested", "changes_requested"], "proceed")).toBe("revise");
    expect(arbitrationDecision(["changes_requested", "changes_requested"], "stop")).toBe("revise");
  });

  it("兩家分歧時依 tieBreak；第三方反對時停止", () => {
    expect(arbitrationDecision(["approve", "changes_requested"], "proceed")).toBe("proceed");
    expect(arbitrationDecision(["approve", "changes_requested"], "stop")).toBe("stop");
    expect(arbitrationDecision(["changes_requested"], "proceed")).toBe("stop");
  });

  it("仲裁者寫 reject 時保留反對理由並當成 changes_requested", () => {
    expect(ArbiterResult.parse({
      verdict: "reject",
      items: [{ criterion: "AC-12", status: "not_met", note: "車資輸入沒有行為測試" }],
    })).toEqual({
      verdict: "changes_requested",
      items: [{ criterion: "AC-12", status: "not_met", note: "車資輸入沒有行為測試" }],
    });
  });

  it("沒有有效裁決時不進入計畫修訂或依 tieBreak 放行", () => {
    expect(arbitrationDecision(["abstain", "abstain"], "proceed")).toBe("invalid");
    expect(arbitrationDecision(["approve", "abstain"], "proceed")).toBe("invalid");
  });
});
