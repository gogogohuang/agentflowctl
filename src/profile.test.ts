import { describe, expect, it } from "vitest";
import { anyOf, GO_PROFILE, isSourceFile, mergeProfile, NEUTRAL_PROFILE, NODE_PROFILE, profileGaps, PYTHON_PROFILE, RUST_PROFILE, testSourceOf, type EcosystemProfile } from "./profile.js";

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
