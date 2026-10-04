import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFingerprint, effectiveDefaults, mergeGeneratedProfile, overlayGenerated, readDetected, writeDetected } from "./detectedFile.js";
import { detectProjectDefaults, NO_INSTALL, withProjectDefaults } from "./detect.js";
import type { DetectedFile } from "./schemas.js";

const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-detected-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};
const file = (root: string, over: Partial<DetectedFile> = {}): DetectedFile => ({
  fingerprint: detectFingerprint(root), generatedAt: "2026-10-03T00:00:00.000Z", checks: [], dropped: [], ...over,
});

describe("detectFingerprint", () => {
  it("特徵檔內容改變時指紋跟著變，無關檔案不影響", () => {
    const dir = project({ Makefile: "test:\n\tmake a\n", "notes.txt": "x" });
    const before = detectFingerprint(dir);
    writeFileSync(join(dir, "notes.txt"), "y");
    expect(detectFingerprint(dir)).toBe(before);
    writeFileSync(join(dir, "Makefile"), "test:\n\tmake b\n");
    expect(detectFingerprint(dir)).not.toBe(before);
  });

  it(".github/workflows 的檔案也算特徵", () => {
    const dir = project({});
    const before = detectFingerprint(dir);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
    expect(detectFingerprint(dir)).not.toBe(before);
  });
});

describe("detectFingerprint 容錯", () => {
  it(".github/workflows 是檔案時不丟例外", () => {
    const dir = project({});
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "workflows"), "不是目錄");
    expect(() => detectFingerprint(dir)).not.toThrow();
  });
});

describe("readDetected／writeDetected", () => {
  it("寫入後讀得回來；沒有檔案或格式不合回傳 undefined", () => {
    const dir = project({});
    expect(readDetected(dir)).toBeUndefined();
    writeDetected(dir, file(dir, { test: "make test" }));
    expect(readDetected(dir)?.test).toBe("make test");
    writeFileSync(join(dir, ".agentflowctl", "detected.json"), "{壞掉");
    expect(readDetected(dir)).toBeUndefined();
  });
});

describe("effectiveDefaults", () => {
  it("overlayGenerated：沒有 test 時不走紅綠燈，其餘檢查照常保留", () => {
    const dir = project({ Makefile: "x" });
    const g = file(dir, { checks: [{ name: "unit-tests", cmd: "make test" }] });
    const d = overlayGenerated(detectProjectDefaults(dir), g);
    expect(d.testFramework).toBe(false);
    expect(d.checks).toEqual([{ name: "unit-tests", cmd: "make test" }]);
    const kept = withProjectDefaults({}, d) as { checks: { name: string }[] };
    expect(kept.checks.map((c) => c.name)).toEqual(["unit-tests"]);
  });

  it("未知類型且指紋相符時疊上動態結果：有 test 就走紅綠燈", () => {
    const dir = project({ Makefile: "test:\n\ttrue\n" });
    writeDetected(dir, file(dir, { install: "make deps", test: "make test", checks: [{ name: "lint", cmd: "make lint", finalOnly: true }], testPattern: "_spec\\.rb$" }));
    const d = effectiveDefaults(dir);
    expect(d.ecosystem).toBe("generated");
    expect(d.install).toBe("make deps");
    expect(d.test).toBe("make test");
    expect(d.checks).toEqual([{ name: "test", cmd: "make test" }, { name: "lint", cmd: "make lint", finalOnly: true }]);
    expect(d.testFramework).toBe(true);
    expect(d.testPattern).toBe("_spec\\.rb$");
  });

  it("全部欄位都被丟掉時等同未知類型：不安裝、沒有檢查、不走紅綠燈", () => {
    const dir = project({ Makefile: "x:\n" });
    writeDetected(dir, file(dir, { dropped: [{ field: "test", reason: "基底上未通過" }] }));
    const d = effectiveDefaults(dir);
    expect(d.install).toBe(NO_INSTALL);
    expect(d.checks).toEqual([]);
    expect(d.testFramework).toBe(false);
  });

  it("指紋不符、或專案已有內建偵測（Node 等）時不套用動態結果", () => {
    const stale = project({ Makefile: "a:\n" });
    writeDetected(stale, file(stale, { fingerprint: "舊的", test: "make test" }));
    expect(effectiveDefaults(stale).ecosystem).toBe("unknown");
    const node = project({ "package.json": "{}" });
    writeDetected(node, file(node, { test: "make test" }));
    expect(effectiveDefaults(node)).toEqual(detectProjectDefaults(node));
  });
});

describe("overlayGenerated", () => {
  it("結果的 ecosystem 為 generated，source 指向 detected.json", () => {
    const dir = project({});
    const d = overlayGenerated(detectProjectDefaults(dir), file(dir, { test: "t" }));
    expect(d.ecosystem).toBe("generated");
    expect(d.source).toContain("detected.json");
  });
});

describe("mergeGeneratedProfile", () => {
  it("已辨識的專案：generated 只補 profile 的空欄位，不改 install／test／checks", () => {
    const dir = project({ "requirements.txt": "pytest\n" });
    const base = detectProjectDefaults(dir);
    const merged = mergeGeneratedProfile(base, file(dir, { assertPattern: "SHOULD_NOT_WIN", skipPatterns: ["@slow\\b"] }));
    expect(merged.install).toBe(base.install);
    expect(merged.profile.assertPattern).toBe(base.profile.assertPattern);
    expect(merged.profile.skipPatterns).toHaveLength(2);
  });

  it("detected.json 裡不安全的目錄名稱（手改或舊檔）在合併時被丟掉", () => {
    const unk = project({ Makefile: "t:\n" });
    writeDetected(unk, file(unk, { depDirs: [".flow", ".agentflowctl", ".git", "../x", ".venv"], skipDirs: ["a/b", "vendor"] }));
    const p = effectiveDefaults(unk).profile;
    expect(p.depDirs).toEqual([".venv"]);
    expect(p.skipDirs).toContain("vendor");
    expect(p.skipDirs).not.toContain("a/b");
  });

  it("effectiveDefaults：已辨識的專案疊上 generated 的 profile 補充，未知類型則整個疊上", () => {
    const dir = project({ "requirements.txt": "pytest\n" });
    writeDetected(dir, file(dir, { suppressPatterns: ["NOLINT"] }));
    const eff = effectiveDefaults(dir);
    expect(eff.ecosystem).toBe("python");
    expect(eff.profile.suppressPatterns).toContain("NOLINT");
    const unk = project({ Makefile: "t:\n" });
    writeDetected(unk, file(unk, { assertPattern: "chk\\(" }));
    expect(effectiveDefaults(unk).profile.assertPattern).toBe("chk\\(");
  });
});
