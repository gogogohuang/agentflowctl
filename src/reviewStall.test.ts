import { describe, expect, it } from "vitest";
import { reviewIssue } from "./feedback.js";
import { nextReviewStall, unmetCriteriaKey } from "./reviewStall.js";

describe("整體審查停滯偵測", () => {
  it("只看未通過的 AC 與狀態，備註措辭不同仍視為同一組", () => {
    const a = unmetCriteriaKey([reviewIssue("AC-20", "partial", "缺證據"), reviewIssue("AC-3", "not_met", "x")]);
    const b = unmetCriteriaKey([reviewIssue("AC-3", "not_met", "換個說法"), reviewIssue("AC-20", "partial", "仍缺")]);
    expect(a).toBe("AC-20:partial,AC-3:not_met");
    expect(b).toBe(a);
  });

  it("額外發現不算：只有額外發現時不累計", () => {
    const key = unmetCriteriaKey(['<extra_finding status="not_met" evidence="e">n</extra_finding>']);
    expect(key).toBe("");
    expect(nextReviewStall({ key: "AC-1:partial", count: 2 }, key)).toBeUndefined();
  });

  it("相同累加、不同重數", () => {
    const first = nextReviewStall(undefined, "AC-1:partial");
    const second = nextReviewStall(first, "AC-1:partial");
    expect(second).toEqual({ key: "AC-1:partial", count: 2 });
    expect(nextReviewStall(second, "AC-1:not_met")).toEqual({ key: "AC-1:not_met", count: 1 });
  });
});
