import { describe, expect, it } from "vitest";
import { brokenPackageImport, foreignFailingTests, packageImports, sourceOfTest, violatingTestChanges } from "./testGuard.js";

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

describe("foreignFailingTests：失敗的測試檔不是本任務寫的", () => {
  const mine = ["src/pages/a/format.test.ts"];

  it("vitest 輸出裡失敗的是別的測試檔：回傳那些檔案（去重）", () => {
    const output = [
      " ✓ src/pages/a/format.test.ts (53 tests) 12ms",
      " ❯ src/pages/b/Card.reason.test.tsx (13 tests | 13 failed) 80ms",
      "FAIL  src/pages/b/Card.reason.test.tsx > 優先序 > 顯示原因",
      "FAIL  src/pages/b/Card.reason.test.tsx > 優先序 > 顯示未知原因",
    ].join("\n");
    expect(foreignFailingTests(output, mine)).toEqual(["src/pages/b/Card.reason.test.tsx"]);
  });

  it("通過的檔案（✓）不算失敗，即使不是本任務的", () => {
    const output = " ✓ src/other.test.ts (3 tests)\n FAIL  src/pages/a/format.test.ts > x\n";
    expect(foreignFailingTests(output, mine)).toEqual([]);
  });

  it("失敗的只有本任務的測試檔：回傳空陣列", () => {
    expect(foreignFailingTests("FAIL  src/pages/a/format.test.ts > x\n", mine)).toEqual([]);
  });

  it("本任務與別的測試檔都失敗：仍回傳別的（基線已壞）", () => {
    const output = "FAIL  src/pages/a/format.test.ts > x\nFAIL  src/old.spec.ts > y\n";
    expect(foreignFailingTests(output, mine)).toEqual(["src/old.spec.ts"]);
  });

  it("輸出裡認不出任何失敗的測試檔（例如只有堆疊）：視為無法判斷，回傳空陣列", () => {
    expect(foreignFailingTests("AssertionError: expected 1 to be 2\n    at feature.test.mjs:3:1", mine)).toEqual([]);
  });

  it("去掉 ANSI 色碼與行號後仍能比對，路徑尾端相同視為同一檔", () => {
    const output = "\u001b[31mFAIL\u001b[39m  format.test.ts:12:5 > x\n";
    expect(foreignFailingTests(output, mine)).toEqual([]);
  });
});
