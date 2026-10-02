import { describe, expect, it } from "vitest";
import { brokenPackageImport, packageImports, sourceOfTest, violatingTestChanges } from "./testGuard.js";

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

describe("套件匯出缺失判斷", () => {
  const src = [
    "import { renderHook, act as doAct } from '@testing-library/react'",
    "import type { Foo } from 'zod'",
    "import { useDriverDashboard } from './useDriverDashboard'",
    "import { helper } from '@/utils/helper'",
  ].join("\n");

  it("只收集由套件匯入的符號，排除相對路徑與別名", () => {
    expect([...packageImports(src)].sort()).toEqual(["Foo", "doAct", "renderHook"]);
  });

  it("輸出是套件匯入符號 is not a function 時回傳該符號（含色碼）", () => {
    const out = "\u001b[31mTypeError\u001b[39m: renderHook is not a function";
    expect(brokenPackageImport(out, packageImports(src))).toBe("renderHook");
  });

  it("尚未實作的專案函式 is not a function 不算", () => {
    expect(brokenPackageImport("TypeError: useDriverDashboard is not a function", packageImports(src))).toBeUndefined();
    expect(brokenPackageImport("TypeError: x.renderHook is not a function", packageImports(src))).toBeUndefined();
  });
});
