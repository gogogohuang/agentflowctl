import { describe, expect, it } from "vitest";
import { sourceOfTest, violatingTestChanges } from "./testGuard.js";

const re = /\.(test|spec)\.[cm]?[jt]sx?$/;

describe("testGuard", () => {
  it("由測試檔名推出被測檔", () => {
    expect(sourceOfTest("a/b/foo.test.ts")).toBe("a/b/foo.ts");
    expect(sourceOfTest("a/Foo.spec.tsx")).toBe("a/Foo.tsx");
    expect(sourceOfTest("a/foo.ts")).toBeUndefined();
  });

  it("修改測試檔算違規", () => {
    expect(violatingTestChanges(["a/foo.test.ts", "a/foo.ts"], [], re)).toEqual(["a/foo.test.ts"]);
  });

  it("只刪測試檔、被測檔還在，算違規", () => {
    expect(violatingTestChanges(["a/foo.test.ts"], ["a/foo.test.ts"], re)).toEqual(["a/foo.test.ts"]);
  });

  it("測試檔與被測檔一起刪除則放行", () => {
    expect(violatingTestChanges(["a/foo.test.ts", "a/foo.ts"], ["a/foo.test.ts", "a/foo.ts"], re)).toEqual([]);
  });

  it("沒有對應被測檔的測試檔被刪除，算違規", () => {
    expect(violatingTestChanges(["a/x.test.ts"], ["a/x.test.ts", "a/other.ts"], re)).toEqual(["a/x.test.ts"]);
  });
});
