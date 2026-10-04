import { describe, expect, it } from "vitest";
import { anyOf, compileOrUndefined, GO_PROFILE, isSafePattern, unsafePatternReason, isSourceFile, mergeProfile, NEUTRAL_PROFILE, NODE_PROFILE, profileGaps, PYTHON_PROFILE, RUST_PROFILE, testSourceOf, type EcosystemProfile } from "./profile.js";

const ALL: [string, EcosystemProfile][] = [
  ["node", NODE_PROFILE], ["python", PYTHON_PROFILE], ["go", GO_PROFILE], ["rust", RUST_PROFILE], ["neutral", NEUTRAL_PROFILE],
];

describe("profile 資料", () => {
  it.each(ALL)("%s：所有字串都是合法的正規表示式", (_name, p) => {
    const sources = [...p.skipPatterns, ...p.suppressPatterns, ...p.testSourcePairs.map((t) => t.re), p.assertPattern, p.testFilePattern, p.failureLine].filter((s): s is string => s !== undefined);
    for (const s of sources) expect(() => new RegExp(s), s).not.toThrow();
  });

  it("node：skip、抑制、斷言與原本的 testGuard 規則一致", () => {
    expect(anyOf(NODE_PROFILE.skipPatterns)!.test("  it.skip('x', () => {})")).toBe(true);
    expect(anyOf(NODE_PROFILE.suppressPatterns)!.test("// @ts-ignore")).toBe(true);
    expect(new RegExp(NODE_PROFILE.assertPattern!).test("expect(a).toBe(1)")).toBe(true);
  });

  it("python：pytest 的 skip、抑制與不帶括號的 assert", () => {
    expect(anyOf(PYTHON_PROFILE.skipPatterns)!.test("@pytest.mark.skip(reason='x')")).toBe(true);
    expect(anyOf(PYTHON_PROFILE.skipPatterns)!.test("    pytest.skip('x')")).toBe(true);
    expect(anyOf(PYTHON_PROFILE.suppressPatterns)!.test("import x  # type: ignore")).toBe(true);
    expect(new RegExp(PYTHON_PROFILE.assertPattern!).test("    assert a == 1")).toBe(true);
    expect(new RegExp(PYTHON_PROFILE.assertPattern!).test("    result = assertion_count")).toBe(false);
  });

  it("go 與 rust 的 skip、抑制", () => {
    expect(anyOf(GO_PROFILE.skipPatterns)!.test("\tt.Skip(\"x\")")).toBe(true);
    expect(anyOf(GO_PROFILE.suppressPatterns)!.test("x := 1 //nolint:unused")).toBe(true);
    expect(anyOf(RUST_PROFILE.skipPatterns)!.test("#[ignore]")).toBe(true);
    expect(anyOf(RUST_PROFILE.suppressPatterns)!.test("#[allow(dead_code)]")).toBe(true);
  });

  it.each(ALL)("%s：skipDirs 涵蓋舊版共用的略過目錄", (_name, p) => {
    for (const d of [".git", ".agentflowctl", ".flow", ".worktree", ".worktrees", "dist", "build", "node_modules", "venv", ".venv", "target", "__pycache__"]) {
      expect(p.skipDirs, d).toContain(d);
    }
  });

  it("anyOf：空陣列回傳 undefined", () => {
    expect(anyOf([])).toBeUndefined();
  });

  it("testSourceOf：各生態系統的測試檔對應被測檔", () => {
    expect(testSourceOf(NODE_PROFILE, "src/foo.test.ts")).toBe("src/foo.ts");
    expect(testSourceOf(NODE_PROFILE, "src/foo.spec.tsx")).toBe("src/foo.tsx");
    expect(testSourceOf(NODE_PROFILE, "src/foo.ts")).toBeUndefined();
    expect(testSourceOf(PYTHON_PROFILE, "tests/test_foo.py")).toBe("tests/foo.py");
    expect(testSourceOf(PYTHON_PROFILE, "src/foo_test.py")).toBe("src/foo.py");
    expect(testSourceOf(GO_PROFILE, "pkg/foo_test.go")).toBe("pkg/foo.go");
    expect(testSourceOf(RUST_PROFILE, "src/foo_test.rs")).toBe("src/foo.rs");
    expect(testSourceOf(NEUTRAL_PROFILE, "src/foo.test.ts")).toBeUndefined();
  });

  it("isSourceFile：依副檔名", () => {
    expect(isSourceFile(NODE_PROFILE, "a/b.vue")).toBe(true);
    expect(isSourceFile(NODE_PROFILE, "README.md")).toBe(false);
    expect(isSourceFile(PYTHON_PROFILE, "a.py")).toBe(true);
    expect(isSourceFile(NEUTRAL_PROFILE, "a.py")).toBe(false);
  });
});

describe("profileGaps／mergeProfile", () => {
  it("profileGaps：列出空著的守門欄位", () => {
    expect(profileGaps(NODE_PROFILE)).toEqual([]);
    expect(profileGaps(NEUTRAL_PROFILE).sort()).toEqual(["assertPattern", "failureLine", "skipPatterns", "suppressPatterns"]);
  });

  it("mergeProfile：只補不蓋，規則取聯集", () => {
    const merged = mergeProfile(PYTHON_PROFILE, { skipPatterns: [String.raw`@slow\b`], assertPattern: "SHOULD_NOT_WIN", depDirs: ["env"] });
    expect(merged.skipPatterns).toHaveLength(2);
    expect(merged.assertPattern).toBe(PYTHON_PROFILE.assertPattern); // 已有值不蓋
    expect(merged.depDirs).toEqual([".venv", "env"]);
    expect(mergeProfile(NEUTRAL_PROFILE, { assertPattern: "chk\\(" }).assertPattern).toBe("chk\\(");
  });
});

describe("isSafePattern：agent 提案規則的回溯風險檢查", () => {
  it.each(ALL)("%s：內建規則全部通過（避免檢查太嚴）", (_name, p) => {
    const sources = [...p.skipPatterns, ...p.suppressPatterns, ...p.testSourcePairs.map((t) => t.re), p.assertPattern, p.testFilePattern, p.failureLine].filter((s): s is string => s !== undefined);
    for (const s of sources) expect(unsafePatternReason(s), s).toBeUndefined();
  });

  it("擋下巢狀量詞、群組內交替再重複、反向參照、具名群組、lookbehind 內的量詞、太長與無法編譯的規則", () => {
    const bad = [String.raw`(a+)+$`, String.raw`(a*)*`, String.raw`(\w+\s?)+`, String.raw`(.*)+`, String.raw`(a|aa)+`, String.raw`((a+)b)+`, String.raw`(?:x{2,})*`, String.raw`(a+){2,5}`,
      String.raw`(a)\1`, String.raw`(?<n>a)\k<n>`, String.raw`(?<n>a)`, String.raw`(?<=a+)b`, String.raw`.*.*.*x`, "a".repeat(301), "(["];
    for (const src of bad) expect(isSafePattern(src), src).toBe(false);
  });

  it("一般的規則照常通過：跳脫的反斜線、字元類別裡的括號與量詞、群組後面只接 ?", () => {
    const good = [String.raw`\\1`, String.raw`[(a+)+]`, String.raw`(?:_eq|_ne)?`, String.raw`(?:ab)+`, String.raw`(a+)?`, String.raw`#\s*(?:noqa|type:\s*ignore)`, String.raw`(?=a+)b`, String.raw`x{2}`, "a{", "a".repeat(300)];
    for (const src of good) expect(isSafePattern(src), src).toBe(true);
  });
});

describe("規則編譯失敗時停用而不丟例外", () => {
  it("anyOf 略過無法編譯的規則；全部無法編譯時回傳 undefined", () => {
    expect(() => anyOf(["(", "@slow"])).not.toThrow();
    expect(anyOf(["(", "@slow"])!.test("@slow")).toBe(true);
    expect(anyOf(["(", "["])).toBeUndefined();
  });

  it("compileOrUndefined：無法編譯或沒有規則時回傳 undefined", () => {
    expect(compileOrUndefined("(")).toBeUndefined();
    expect(compileOrUndefined(undefined)).toBeUndefined();
    expect(compileOrUndefined("a", "g")!.flags).toBe("g");
  });
});
