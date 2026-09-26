import { describe, expect, it } from "vitest";
import { arbitrationDecision } from "./arbitration.js";

describe("計畫仲裁結果", () => {
  it("兩家都反對時先修訂，達到仲裁上限才停止", () => {
    expect(arbitrationDecision(["changes_requested", "changes_requested"], "proceed", 1, 3)).toBe("revise");
    expect(arbitrationDecision(["changes_requested", "changes_requested"], "proceed", 3, 3)).toBe("stop");
  });

  it("兩家分歧時依 tieBreak；第三方反對時停止", () => {
    expect(arbitrationDecision(["approve", "changes_requested"], "proceed", 1, 3)).toBe("proceed");
    expect(arbitrationDecision(["approve", "changes_requested"], "stop", 1, 3)).toBe("stop");
    expect(arbitrationDecision(["changes_requested"], "proceed", 1, 3)).toBe("stop");
  });
});
