import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RepoConfig } from "./schemas.js";

/**
 * 依專案現況推出 install、test、checks 的預設指令。
 * flow.config.json 沒寫的欄位才會用這裡的結果，手動設定一律優先。
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type Check = { name: string; cmd: string };

export interface ProjectDefaults {
  manager: PackageManager;
  /** 判斷套件管理器的依據，給人看 */
  source: string;
  install: string;
  test: string;
  checks: Check[];
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

interface PackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
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

export function detectProjectDefaults(root: string): ProjectDefaults {
  const pkg = readPackageJson(root);
  const { manager, source } = detectManager(root, pkg);
  const defaults = RepoConfig.parse({});
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const checks = defaults.checks.map(({ name, cmd }) => {
    const script = CHECK_SCRIPTS[name]?.find((s) => typeof scripts[s] === "string");
    return { name, cmd: script ? `${manager} run ${script}` : withExec(cmd, manager) };
  });
  return { manager, source, install: INSTALL[manager], test: withExec(defaults.test, manager), checks };
}

/** 補上原始設定裡沒寫的 install、test、checks；不是物件就原樣回傳，交給 schema 報錯 */
export function withProjectDefaults(raw: unknown, detected: ProjectDefaults): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { install, test, checks } = detected;
  return { install, test, checks, ...raw };
}

/** run 開始時印出的說明：只列出這次用了偵測結果的欄位 */
export function describeDetected(raw: Record<string, unknown>, detected: ProjectDefaults): string[] {
  const lines: string[] = [];
  if (!("install" in raw)) lines.push(`   install：${detected.install}`);
  if (!("test" in raw)) lines.push(`   test：${detected.test}`);
  if (!("checks" in raw)) lines.push(...detected.checks.map((c) => `   checks.${c.name}：${c.cmd}`));
  if (!lines.length) return [];
  const why = detected.source === "預設" ? "預設" : `依 ${detected.source}`;
  return [`🔧 依專案偵測指令：${detected.manager}（${why}）`, ...lines];
}
