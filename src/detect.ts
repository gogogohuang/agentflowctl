import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLINT_IGNORE_ARGS, RepoConfig, VITEST_WORKTREE_EXCLUDES } from "./schemas.js";

/**
 * 依專案現況推出 install、test、checks 的預設指令。
 * flow.config.json 沒寫的欄位才會用這裡的結果，手動設定一律優先。
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type Check = { name: string; cmd: string; finalOnly?: boolean; changedOnly?: boolean };

export interface ProjectDefaults {
  manager: PackageManager;
  /** 判斷套件管理器的依據，給人看 */
  source: string;
  install: string;
  test: string;
  checks: Check[];
  /** package.json 看得出有測試框架；沒有就不做紅綠燈 */
  testFramework: boolean;
}

const LOCKFILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

/** 不鎖 lockfile：implement 階段 agent 可能新增依賴 */
const INSTALL: Record<PackageManager, string> = {
  npm: RepoConfig.parse({}).install,
  pnpm: "pnpm install",
  yarn: "yarn install",
  bun: "bun install",
};

/** 執行專案內 bin 的前綴，取代預設指令裡的 npx */
const EXEC: Record<PackageManager, string> = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" };

/** 每項檢查會找的 script 名稱，依序取第一個存在的 */
const CHECK_SCRIPTS: Record<string, string[]> = {
  typecheck: ["typecheck", "type-check"],
  lint: ["lint"],
  test: ["test"],
  build: ["build"],
};

/** 每個任務不跑、最後才跑的檢查 */
const FINAL_CHECKS = new Set(["typecheck", "lint"]);

/** 出現在依賴裡就代表專案有測試框架 */
const TEST_FRAMEWORKS = ["vitest", "jest", "mocha", "ava", "jasmine", "tap", "uvu", "@playwright/test", "cypress"];

interface PackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function hasTestFramework(pkg: PackageJson): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (TEST_FRAMEWORKS.some((name) => name in deps)) return true;
  const script = pkg.scripts?.test;
  // npm init 產生的佔位 script 不算
  return typeof script === "string" && !/no test specified/i.test(script);
}

function readPackageJson(root: string): PackageJson {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg && typeof pkg === "object" ? (pkg as PackageJson) : {};
  } catch {
    return {};
  }
}

function detectManager(root: string, pkg: PackageJson): { manager: PackageManager; source: string } {
  if (typeof pkg.packageManager === "string") {
    const name = pkg.packageManager.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      return { manager: name, source: "package.json 的 packageManager" };
    }
  }
  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(root, file))) return { manager, source: file };
  }
  return { manager: "npm", source: "預設" };
}

const withExec = (cmd: string, manager: PackageManager) => cmd.replace(/^npx /, `${EXEC[manager]} `);

/** npm run 要用 -- 才會把參數轉給 script；pnpm、yarn、bun 直接接在後面 */
const withArgs = (run: string, args: string, manager: PackageManager) =>
  `${run}${manager === "npm" ? " --" : ""} ${args}`;

export function detectProjectDefaults(root: string): ProjectDefaults {
  const pkg = readPackageJson(root);
  const { manager, source } = detectManager(root, pkg);
  const defaults = RepoConfig.parse({});
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const checks = defaults.checks.flatMap(({ name, cmd }): Check[] => {
    const script = CHECK_SCRIPTS[name]?.find((s) => typeof scripts[s] === "string");
    // lint 與型別檢查只在最後整支分支才跑，專案沒有對應 script 就略過，不退回預設指令
    if (FINAL_CHECKS.has(name)) {
      if (!script) return [];
      if (name !== "lint") return [{ name, cmd: `${manager} run ${script}`, finalOnly: true }];
      // lint script 若是 eslint（常見寫法 eslint .）會掃到 .flow/ 與本機 worktree，所以在指令列補上略過
      const eslint = /\beslint\b/.test(String(scripts[script]));
      const run = `${manager} run ${script}`;
      return [{ name, cmd: eslint ? withArgs(run, ESLINT_IGNORE_ARGS, manager) : run, finalOnly: true, changedOnly: true }];
    }
    if (!script) return [{ name, cmd: withExec(cmd, manager) }];
    const run = `${manager} run ${script}`;
    // 專案 script 已是 vitest 時只附加排除，不改寫 script 本身；其他測試指令維持原樣
    const scriptCmd = name === "test" && /\bvitest\b/.test(String(scripts[script])) ? withArgs(run, VITEST_WORKTREE_EXCLUDES, manager) : run;
    return [{ name, cmd: scriptCmd }];
  });
  // 紅綠燈與 checks.test 要跑同一個框架：專案有 test script 就用它（例如 node:test 專案），否則用預設的 vitest
  const testScript = scripts.test;
  const hasRealScript = typeof testScript === "string" && !/no test specified/i.test(testScript);
  const test = hasRealScript ? (checks.find((c) => c.name === "test")?.cmd ?? withExec(defaults.test, manager)) : withExec(defaults.test, manager);
  return { manager, source, install: INSTALL[manager], test, checks, testFramework: hasTestFramework(pkg) };
}

/** 手動設定 test 指令就當作有測試框架 */
export const usesTestFramework = (raw: unknown, detected: ProjectDefaults): boolean =>
  detected.testFramework || (!!raw && typeof raw === "object" && "test" in raw);

/** 補上原始設定裡沒寫的 install、test、checks；不是物件就原樣回傳，交給 schema 報錯 */
export function withProjectDefaults(raw: unknown, detected: ProjectDefaults): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { install, test } = detected;
  // 沒有測試框架也沒手動設定 test 時，預設的檢查不含 test
  const checks = usesTestFramework(raw, detected) ? detected.checks : detected.checks.filter((c) => c.name !== "test");
  return { install, test, checks, ...raw };
}

/** run 開始時印出的說明：只列出這次用了偵測結果的欄位 */
export function describeDetected(raw: Record<string, unknown>, detected: ProjectDefaults): string[] {
  const lines: string[] = [];
  const framework = usesTestFramework(raw, detected);
  if (!("install" in raw)) lines.push(`   install：${detected.install}`);
  if (!("test" in raw) && framework) lines.push(`   test：${detected.test}`);
  if (!("checks" in raw)) lines.push(...detected.checks.filter((c) => framework || c.name !== "test").map((c) => `   checks.${c.name}：${c.cmd}${c.finalOnly ? "（只在最後驗證，" + (c.changedOnly ? "只檢查改過的檔案）" : "整個專案）") : ""}`));
  if (!framework) lines.push("ℹ️  未偵測到測試框架，所有任務略過紅綠燈，也不跑 test 檢查（在 flow.config.json 設定 test 可改回來）");
  if (!lines.length) return [];
  const why = detected.source === "預設" ? "預設" : `依 ${detected.source}`;
  return [`🔧 依專案偵測指令：${detected.manager}（${why}）`, ...lines];
}
