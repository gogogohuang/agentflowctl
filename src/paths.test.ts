import { describe, expect, it } from "vitest";
import { handoffPath, laneId, laneParts, logDir, ownerId, runDir, sharedRunDir, worktreeDir } from "./paths.js";

describe("車道路徑", () => {
  it("車道 id 由 run id 與任務 id 組成，可拆回", () => {
    expect(laneId("f-abc", "T-2")).toBe("f-abc+T-2");
    expect(laneParts("f-abc+T-2")).toEqual({ parent: "f-abc", task: "T-2" });
    expect(laneParts("f-abc")).toBeUndefined();
    expect(ownerId("f-abc+T-2")).toBe("f-abc");
    expect(ownerId("f-abc")).toBe("f-abc");
  });

  it("車道自己有 state、worktree 的位置，log 與交接帳本則和所屬 run 共用", () => {
    const lane = "f-abc+T-2";
    expect(runDir(lane)).toBe(`${runDir("f-abc")}/lanes/T-2`);
    expect(worktreeDir(lane)).toBe(`${runDir("f-abc")}/lanes/T-2/worktree`);
    expect(logDir(lane)).toBe(logDir("f-abc"));
    expect(handoffPath(lane)).toBe(handoffPath("f-abc"));
    expect(sharedRunDir(lane)).toBe(runDir("f-abc"));
  });

  it("一般 run 的路徑不變", () => {
    expect(runDir("f-abc")).toBe(sharedRunDir("f-abc"));
    expect(worktreeDir("f-abc")).toMatch(/worktrees\/f-abc$/);
  });
});
