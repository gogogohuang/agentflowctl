import { describe, expect, it } from "vitest";
import { brokenPackageImport, foreignFailingTests, packageImports, sourceOfTest, violatingTestChanges, weakenedChecks, weakenedMessage } from "./testGuard.js";
import { NEUTRAL_PROFILE, NODE_PROFILE, PYTHON_PROFILE, GO_PROFILE, type EcosystemProfile } from "./profile.js";

const re = /\.(test|spec)\.[cm]?[jt]sx?$/;

describe("testGuard", () => {
  it("由測試檔名推出被測檔", () => {
    expect(sourceOfTest(NODE_PROFILE, "a/b/foo.test.ts")).toBe("a/b/foo.ts");
    expect(sourceOfTest(NODE_PROFILE, "a/Foo.spec.tsx")).toBe("a/Foo.tsx");
    expect(sourceOfTest(NODE_PROFILE, "a/foo.ts")).toBeUndefined();
  });

  it("修改測試檔算違規", () => {
    expect(violatingTestChanges(["a/foo.test.ts", "a/foo.ts"], [], re, NODE_PROFILE)).toEqual(["a/foo.test.ts"]);
  });

  it("只刪測試檔、被測檔還在，算違規", () => {
    expect(violatingTestChanges(["a/foo.test.ts"], ["a/foo.test.ts"], re, NODE_PROFILE)).toEqual(["a/foo.test.ts"]);
  });

  it("測試檔與被測檔一起刪除則放行", () => {
    expect(violatingTestChanges(["a/foo.test.ts", "a/foo.ts"], ["a/foo.test.ts", "a/foo.ts"], re, NODE_PROFILE)).toEqual([]);
  });

  it("沒有對應被測檔的測試檔被刪除，算違規", () => {
    expect(violatingTestChanges(["a/x.test.ts"], ["a/x.test.ts", "a/other.ts"], re, NODE_PROFILE)).toEqual(["a/x.test.ts"]);
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
    expect(foreignFailingTests(output, mine, NODE_PROFILE)).toEqual(["src/pages/b/Card.reason.test.tsx"]);
  });

  it("通過的檔案（✓）不算失敗，即使不是本任務的", () => {
    const output = " ✓ src/other.test.ts (3 tests)\n FAIL  src/pages/a/format.test.ts > x\n";
    expect(foreignFailingTests(output, mine, NODE_PROFILE)).toEqual([]);
  });

  it("失敗的只有本任務的測試檔：回傳空陣列", () => {
    expect(foreignFailingTests("FAIL  src/pages/a/format.test.ts > x\n", mine, NODE_PROFILE)).toEqual([]);
  });

  it("本任務與別的測試檔都失敗：仍回傳別的（基線已壞）", () => {
    const output = "FAIL  src/pages/a/format.test.ts > x\nFAIL  src/old.spec.ts > y\n";
    expect(foreignFailingTests(output, mine, NODE_PROFILE)).toEqual(["src/old.spec.ts"]);
  });

  it("輸出裡認不出任何失敗的測試檔（例如只有堆疊）：視為無法判斷，回傳空陣列", () => {
    expect(foreignFailingTests("AssertionError: expected 1 to be 2\n    at feature.test.mjs:3:1", mine, NODE_PROFILE)).toEqual([]);
  });

  it("別的目錄有同名測試檔失敗：不會被誤認成本任務的", () => {
    const output = "FAIL  src/pages/b/format.test.ts > x\n";
    expect(foreignFailingTests(output, mine, NODE_PROFILE)).toEqual(["src/pages/b/format.test.ts"]);
  });

  it("去掉 ANSI 色碼與行號後仍能比對，路徑尾端相同視為同一檔", () => {
    const output = "\u001b[31mFAIL\u001b[39m  format.test.ts:12:5 > x\n";
    expect(foreignFailingTests(output, mine, NODE_PROFILE)).toEqual([]);
  });
});

const diffOf = (file: string, removed: string[], added: string[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${removed.map((l) => `-${l}`).join("\n")}${removed.length ? "\n" : ""}${added.map((l) => `+${l}`).join("\n")}\n`;

describe("weakenedChecks", () => {
  it("測試檔新增 skip／only／todo", () => {
    for (const line of ["it.skip('a', f)", "describe.only('a', f)", "xit('a', f)", "test.todo('a')"]) {
      expect(weakenedChecks(diffOf("a.test.ts", [], [line]), re, NODE_PROFILE)).toEqual([{ file: "a.test.ts", kind: "skip", count: 1 }]);
    }
  });

  it("非測試檔的 skip 字樣不算", () => {
    expect(weakenedChecks(diffOf("a.ts", [], ["it.skip('a', f)"]), re, NODE_PROFILE)).toEqual([]);
  });

  it("新增 @ts-ignore／@ts-nocheck／eslint-disable，只在程式碼檔案才算", () => {
    expect(weakenedChecks(diffOf("a.ts", [], ["// @ts-ignore"]), re, NODE_PROFILE)).toEqual([{ file: "a.ts", kind: "suppress", count: 1 }]);
    expect(weakenedChecks(diffOf("a.tsx", [], ["/* eslint-disable */"]), re, NODE_PROFILE)).toEqual([{ file: "a.tsx", kind: "suppress", count: 1 }]);
    expect(weakenedChecks(diffOf("README.md", [], ["不要用 @ts-ignore"]), re, NODE_PROFILE)).toEqual([]);
    expect(weakenedChecks(diffOf("pnpm-lock.yaml", [], ["eslint-disable"]), re, NODE_PROFILE)).toEqual([]);
  });

  it("搬移（同一個檔案移除再新增同樣數量）不算", () => {
    expect(weakenedChecks(diffOf("a.ts", ["// @ts-ignore"], ["// @ts-ignore"]), re, NODE_PROFILE)).toEqual([]);
    expect(weakenedChecks(diffOf("a.test.ts", ["it.skip('a', f)"], ["it.skip('b', f)"]), re, NODE_PROFILE)).toEqual([]);
  });

  it("測試檔的斷言變少才算 assertions，增加或持平不算", () => {
    expect(weakenedChecks(diffOf("a.test.ts", ["expect(a).toBe(1);", "expect(b).toBe(2);"], ["expect(a).toBe(1);"]), re, NODE_PROFILE))
      .toEqual([{ file: "a.test.ts", kind: "assertions", count: 1 }]);
    expect(weakenedChecks(diffOf("a.test.ts", ["expect(a).toBe(1);"], ["expect(a).toBe(2);"]), re, NODE_PROFILE)).toEqual([]);
    expect(weakenedChecks(diffOf("a.ts", ["expect(a)"], []), re, NODE_PROFILE)).toEqual([]);
  });

  it(".flow 底下的交接檔與刪除的檔案不看", () => {
    expect(weakenedChecks(diffOf(".flow/x.test.ts", [], ["it.skip('a', f)"]), re, NODE_PROFILE)).toEqual([]);
    expect(weakenedChecks("diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ /dev/null\n-it('a', f)\n", re, NODE_PROFILE)).toEqual([]);
  });

  it("訊息列出檔案與種類", () => {
    expect(weakenedMessage([{ file: "a.test.ts", kind: "skip", count: 2 }])).toContain("a.test.ts（新增 skip／only／todo 2 處）");
  });
});

describe("pytest 專案", () => {
  const pyTest = /(^|\/)test_[^/]+\.py$/;

  it("weakenedChecks：新增 skip 與減少不帶括號的 assert 都擋下", () => {
    const diff = [
      "diff --git a/tests/test_a.py b/tests/test_a.py", "--- a/tests/test_a.py", "+++ b/tests/test_a.py", "@@ -1,4 +1,3 @@",
      "+@pytest.mark.skip(reason='later')", " def test_a():", "-    assert a == 1", "-    assert b == 2", "+    assert a == 1",
    ].join("\n");
    const kinds = weakenedChecks(diff, pyTest, PYTHON_PROFILE).map((w) => w.kind).sort();
    expect(kinds).toEqual(["assertions", "skip"]);
  });

  it("weakenedChecks：python 檔案新增 # type: ignore 算抑制，go 檔案的 @ts-ignore 不算", () => {
    const py = ["+++ b/src/a.py", "+x = 1  # type: ignore"].join("\n");
    expect(weakenedChecks(py, pyTest, PYTHON_PROFILE).map((w) => w.kind)).toEqual(["suppress"]);
    const go = ["+++ b/src/a.go", "+// @ts-ignore"].join("\n");
    expect(weakenedChecks(go, /_test\.go$/, GO_PROFILE)).toEqual([]);
  });

  it("foreignFailingTests：認得 pytest 的 FAILED 行，排除本任務的測試檔", () => {
    const out = [
      "FAILED tests/test_other.py::test_x - assert 1 == 2",
      "FAILED tests/test_mine.py::test_y - assert 1 == 2",
      "PASSED tests/test_ok.py::test_z",
    ].join("\n");
    expect(foreignFailingTests(out, ["tests/test_mine.py"], PYTHON_PROFILE)).toEqual(["tests/test_other.py"]);
  });

  it("foreignFailingTests：不收錄非測試命名的 .py", () => {
    expect(foreignFailingTests("FAILED src/foo.py::test_x", [], PYTHON_PROFILE)).toEqual([]);
  });

  it("violatingTestChanges：測試檔連同被測檔一起刪除時放行", () => {
    const changed = ["tests/test_foo.py", "tests/foo.py"];
    expect(violatingTestChanges(changed, changed, pyTest, PYTHON_PROFILE)).toEqual([]);
    expect(violatingTestChanges(["tests/test_foo.py"], ["tests/test_foo.py"], pyTest, PYTHON_PROFILE)).toEqual(["tests/test_foo.py"]);
  });

  it("NEUTRAL profile：沒有任何規則時不擋", () => {
    const diff = ["+++ b/x.py", "+x = 1  # type: ignore"].join("\n");
    expect(weakenedChecks(diff, /x/, NEUTRAL_PROFILE)).toEqual([]);
    expect(foreignFailingTests("FAIL a.test.ts", [], NEUTRAL_PROFILE)).toEqual([]);
  });
});

describe("profile 規則壞掉或輸入很長時", () => {
  const broken: EcosystemProfile = { ...NODE_PROFILE, skipPatterns: ["("], suppressPatterns: ["["], assertPattern: "(", failureLine: "(", testFilePattern: "[" };

  it("無法編譯的規則讓該守門停用，不丟例外", () => {
    expect(() => weakenedChecks(diffOf("a.test.ts", [], ["it.skip('a', f)"]), re, broken)).not.toThrow();
    expect(weakenedChecks(diffOf("a.test.ts", [], ["it.skip('a', f)"]), re, broken)).toEqual([]);
    expect(() => foreignFailingTests("FAIL src/b.test.ts", ["src/a.test.ts"], broken)).not.toThrow();
    expect(foreignFailingTests("FAIL src/b.test.ts", ["src/a.test.ts"], { ...NODE_PROFILE, testFilePattern: "[" })).toEqual([]);
  });

  it("十萬字元的一行很快處理完", () => {
    const long = "x".repeat(100_000);
    const start = Date.now();
    weakenedChecks(diffOf("a.test.ts", [long], [long + "it.skip"]), re, NODE_PROFILE);
    foreignFailingTests(`FAIL ${long}`, [], NODE_PROFILE);
    foreignFailingTests(`FAILED ${long}`, [], PYTHON_PROFILE);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("只比對每行前 1000 個字元", () => {
    expect(weakenedChecks(diffOf("a.test.ts", [], ["x".repeat(2000) + "it.skip('a', f)"]), re, NODE_PROFILE)).toEqual([]);
    expect(foreignFailingTests(`${"x".repeat(2000)} FAIL src/b.test.ts`, [], NODE_PROFILE)).toEqual([]);
  });
});
