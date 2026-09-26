import { describe, expect, it } from "vitest";
import { ConsistentReviewResult } from "./schemas.js";

describe("審查結果的 verdict 與 items 一致性", () => {
  const unmet = { criterion: "AC-1", status: "not_met", note: "src/form.tsx 缺少錯誤訊息" };

  it("verdict 與 items 一致時通過", () => {
    expect(ConsistentReviewResult.safeParse({ verdict: "approve", items: [] }).success).toBe(true);
    expect(ConsistentReviewResult.safeParse({ verdict: "approve", items: [{ criterion: "AC-1", status: "met" }] }).success).toBe(true);
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [unmet] }).success).toBe(true);
  });

  it("approve 卻有未通過項目時拒絕", () => {
    const r = ConsistentReviewResult.safeParse({ verdict: "approve", items: [unmet] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/AC-1/);
  });

  it("changes_requested 卻沒有未通過項目時拒絕", () => {
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [] }).success).toBe(false);
    expect(ConsistentReviewResult.safeParse({ verdict: "changes_requested", items: [{ criterion: "AC-1", status: "met" }] }).success).toBe(false);
  });
});
