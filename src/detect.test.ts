import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDetected, detectProjectDefaults, withProjectDefaults } from "./detect.js";
import { RepoConfig } from "./schemas.js";

function project(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-detect-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

describe("detectProjectDefaults", () => {
  it("沒有 lockfile 也沒有 scripts 時，結果與 schema 的預設值相同", () => {
    const d = detectProjectDefaults(project({ "package.json": {} }));
    const defaults = RepoConfig.parse({});
    expect(d.manager).toBe("npm");
    expect(d.install).toBe(defaults.install);
    expect(d.test).toBe(defaults.test);
    expect(d.checks).toEqual(defaults.checks);
  });

  it("沒有 package.json 時仍回傳 npm 的預設值", () => {
    const d = detectProjectDefaults(project({}));
    expect(d.manager).toBe("npm");
    expect(d.install).toBe(RepoConfig.parse({}).install);
  });

  it("依 lockfile 判斷套件管理器", () => {
    expect(detectProjectDefaults(project({ "pnpm-lock.yaml": "" })).manager).toBe("pnpm");
    expect(detectProjectDefaults(project({ "yarn.lock": "" })).manager).toBe("yarn");
    expect(detectProjectDefaults(project({ "bun.lock": "" })).manager).toBe("bun");
    expect(detectProjectDefaults(project({ "bun.lockb": "" })).manager).toBe("bun");
    expect(detectProjectDefaults(project({ "package-lock.json": "{}" })).manager).toBe("npm");
  });

  it("packageManager 欄位優先於 lockfile，並記下判斷依據", () => {
    const d = detectProjectDefaults(project({ "package.json": { packageManager: "pnpm@10.4.1+sha512.abc" }, "yarn.lock": "" }));
    expect(d.manager).toBe("pnpm");
    expect(d.source).toBe("package.json 的 packageManager");
    expect(detectProjectDefaults(project({ "yarn.lock": "" })).source).toBe("yarn.lock");
  });

  it("pnpm 專案：install 不鎖 lockfile，沒有對應 script 的檢查改用 pnpm exec", () => {
    const d = detectProjectDefaults(project({ "pnpm-lock.yaml": "" }));
    expect(d.install).toBe("pnpm install");
    expect(d.test).toBe("pnpm exec vitest run");
    expect(d.checks).toEqual([
      { name: "typecheck", cmd: "pnpm exec tsc --noEmit" },
      { name: "lint", cmd: "pnpm exec eslint ." },
      { name: "test", cmd: "pnpm exec vitest run" },
      { name: "build", cmd: "pnpm exec vite build" },
    ]);
  });

  it("yarn 與 bun 的指令寫法", () => {
    const yarn = detectProjectDefaults(project({ "yarn.lock": "" }));
    expect(yarn.install).toBe("yarn install");
    expect(yarn.test).toBe("yarn vitest run");
    const bun = detectProjectDefaults(project({ "bun.lock": "" }));
    expect(bun.install).toBe("bun install");
    expect(bun.test).toBe("bunx vitest run");
  });

  it("package.json 有對應的 script 時改用 run <script>", () => {
    const d = detectProjectDefaults(project({
      "pnpm-lock.yaml": "",
      "package.json": { scripts: { "type-check": "tsc -b", lint: "eslint .", test: "vitest run", build: "tsc -b && vite build" } },
    }));
    expect(d.checks).toEqual([
      { name: "typecheck", cmd: "pnpm run type-check" },
      { name: "lint", cmd: "pnpm run lint" },
      { name: "test", cmd: "pnpm run test" },
      { name: "build", cmd: "pnpm run build" },
    ]);
  });

  it("typecheck 也認得不含連字號的 script 名稱", () => {
    const d = detectProjectDefaults(project({ "package.json": { scripts: { typecheck: "tsc --noEmit" } } }));
    expect(d.checks[0]).toEqual({ name: "typecheck", cmd: "npm run typecheck" });
  });

  it("package.json 不是合法 JSON 時退回 lockfile 判斷", () => {
    const d = detectProjectDefaults(project({ "package.json": "{", "pnpm-lock.yaml": "" }));
    expect(d.manager).toBe("pnpm");
  });
});

describe("withProjectDefaults", () => {
  const detected = detectProjectDefaults(project({ "pnpm-lock.yaml": "" }));

  it("補上設定裡沒寫的 install、test、checks", () => {
    const raw = withProjectDefaults({ tddSplit: false }, detected) as Record<string, unknown>;
    expect(raw.install).toBe("pnpm install");
    expect(raw.test).toBe("pnpm exec vitest run");
    expect(raw.checks).toEqual(detected.checks);
    expect(raw.tddSplit).toBe(false);
  });

  it("手動設定的欄位不會被偵測結果蓋掉", () => {
    const checks = [{ name: "only", cmd: "make check" }];
    const raw = withProjectDefaults({ install: "make deps", checks }, detected) as Record<string, unknown>;
    expect(raw.install).toBe("make deps");
    expect(raw.checks).toEqual(checks);
    expect(raw.test).toBe("pnpm exec vitest run");
  });

  it("不是物件時原樣回傳，交給 schema 報錯", () => {
    expect(withProjectDefaults([], detected)).toEqual([]);
    expect(withProjectDefaults(null, detected)).toBeNull();
  });
});

describe("describeDetected", () => {
  const detected = detectProjectDefaults(project({ "pnpm-lock.yaml": "" }));

  it("列出這次改用偵測結果的欄位", () => {
    expect(describeDetected({ checks: [] }, detected)).toEqual([
      "🔧 依專案偵測指令：pnpm（依 pnpm-lock.yaml）",
      "   install：pnpm install",
      "   test：pnpm exec vitest run",
    ]);
  });

  it("checks 逐項列出", () => {
    const lines = describeDetected({ install: "x", test: "y" }, detected);
    expect(lines.slice(1)).toEqual(detected.checks.map((c) => `   checks.${c.name}：${c.cmd}`));
  });

  it("三個欄位都手動設定時不輸出", () => {
    expect(describeDetected({ install: "x", test: "y", checks: [] }, detected)).toEqual([]);
  });
});
