import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { GO_PROFILE, NEUTRAL_PROFILE, NODE_PROFILE, PYTHON_PROFILE, RUST_PROFILE, type EcosystemProfile } from "./profile.js";
import { ESLINT_IGNORE_ARGS, RepoConfig, VITEST_WORKTREE_EXCLUDES } from "./schemas.js";

/**
 * 依專案現況推出 install、test、checks 的預設指令。
 * flow.config.json 沒寫的欄位才會用這裡的結果，手動設定一律優先。
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type Check = { name: string; cmd: string; finalOnly?: boolean; changedOnly?: boolean };

export type Ecosystem = "node" | "python" | "go" | "rust" | "unknown" | "generated";

export interface ProjectDefaults {
  ecosystem: Ecosystem;
  /** 套件管理器或建置工具（npm、uv、go、cargo…） */
  manager: string;
  /** 判斷的依據，給人看 */
  source: string;
  install: string;
  test: string;
  checks: Check[];
  /** 看得出有測試框架；沒有就不做紅綠燈 */
  testFramework: boolean;
  /** 這類專案的測試檔命名；Node 不填，沿用 schema 預設 */
  testPattern?: string;
  /** 這個生態系統的守門、依賴目錄與 prompt 資料 */
  profile: EcosystemProfile;
}

/** 不需要安裝時的指令：install 在 `&&` 串接裡也要是合法的 shell */
export const NO_INSTALL = "true";

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

/** 有 package.json 卻不像 Vite 專案：沒有 vite 依賴、vite.config 與根目錄 index.html */
function isNonViteProject(root: string, pkg: PackageJson): boolean {
  if (!existsSync(join(root, "package.json"))) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("vite" in deps || existsSync(join(root, "index.html"))) return false;
  return !["ts", "js", "mjs", "mts", "cjs", "cts"].some((ext) => existsSync(join(root, `vite.config.${ext}`)));
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

function detectNode(root: string): ProjectDefaults {
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
    // 非 Vite 專案沒有 build script 就略過，不去 npx 一個用不到的 vite
    if (!script && name === "build" && isNonViteProject(root, pkg)) return [];
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
  return { ecosystem: "node", manager, source, install: INSTALL[manager], test, checks, testFramework: hasTestFramework(pkg), profile: NODE_PROFILE };
}

const GO_TEST_PATTERN = String.raw`_test\.go$`;
const RUST_TEST_PATTERN = String.raw`(^|/)tests/.*\.rs$|_test\.rs$`;
const PYTHON_TEST_PATTERN = String.raw`(^|/)(test_[^/]*|[^/]*_test)\.py$`;

/** 有界遞迴找出符合的檔案（深度 6、最多看 5000 個檔），略過依賴與建置產物目錄 */
export function findFiles(root: string, re: RegExp, skipDirs: readonly string[], max = 5000): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || visited >= max) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= max) return;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) walk(join(dir, entry.name), path, depth + 1);
      } else {
        visited++;
        if (re.test(path)) found.push(path);
      }
    }
  };
  walk(root, "", 0);
  return found;
}

function detectGo(root: string): ProjectDefaults {
  return {
    ecosystem: "go", manager: "go", source: "go.mod",
    install: "go mod download", test: "go test ./...",
    checks: [
      { name: "test", cmd: "go test ./..." },
      { name: "vet", cmd: "go vet ./...", finalOnly: true },
      { name: "build", cmd: "go build ./..." },
    ],
    testFramework: findFiles(root, new RegExp(GO_TEST_PATTERN), GO_PROFILE.skipDirs).length > 0,
    testPattern: GO_TEST_PATTERN,
    profile: GO_PROFILE,
  };
}

function detectRust(root: string): ProjectDefaults {
  return {
    ecosystem: "rust", manager: "cargo", source: "Cargo.toml",
    install: "cargo fetch", test: "cargo test",
    checks: [
      { name: "test", cmd: "cargo test" },
      { name: "clippy", cmd: "cargo clippy", finalOnly: true },
      { name: "build", cmd: "cargo build" },
    ],
    testFramework: findFiles(root, new RegExp(RUST_TEST_PATTERN), RUST_PROFILE.skipDirs).length > 0,
    testPattern: RUST_TEST_PATTERN,
    profile: RUST_PROFILE,
  };
}

function detectPython(root: string): ProjectDefaults {
  const has = (name: string) => existsSync(join(root, name));
  const text = (name: string) => {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      return "";
    }
  };
  const requirements = readdirSync(root).filter((f) => /^requirements.*\.txt$/.test(f));
  const config = ["pyproject.toml", "setup.cfg", "setup.py", "tox.ini", ...requirements].map(text).join("\n");
  const [manager, source, install, run]: [string, string, string, string] = has("uv.lock")
    ? ["uv", "uv.lock", "uv sync", "uv run "]
    : has("poetry.lock")
      ? ["poetry", "poetry.lock", "poetry install --no-interaction", "poetry run "]
      : has("requirements.txt")
        ? ["pip", "requirements.txt", "python3 -m pip install -r requirements.txt", ""]
        : ["pip", "pyproject.toml／setup.py", "python3 -m pip install -e .", ""];
  const pytest = /\bpytest\b/.test(config) || has("pytest.ini") || has("conftest.py");
  const unittest = /\bunittest\b/.test(config);
  const testFiles = findFiles(root, new RegExp(PYTHON_TEST_PATTERN), PYTHON_PROFILE.skipDirs);
  const test = `${run}${pytest ? "pytest" : "python3 -m unittest discover"}`;
  const checks: Check[] = [{ name: "test", cmd: test }];
  if (/\[tool\.ruff/.test(text("pyproject.toml")) || has("ruff.toml") || has(".ruff.toml")) {
    checks.push({ name: "lint", cmd: `${run}ruff check .`, finalOnly: true });
  }
  return { ecosystem: "python", manager, source, install, test, checks, testFramework: pytest || unittest || testFiles.length > 0, testPattern: PYTHON_TEST_PATTERN, profile: PYTHON_PROFILE };
}

function detectUnknown(): ProjectDefaults {
  return { ecosystem: "unknown", manager: "（未辨識）", source: "沒有可辨識的專案檔", install: NO_INSTALL, test: NO_INSTALL, checks: [], testFramework: false, profile: NEUTRAL_PROFILE };
}

export function detectProjectDefaults(root: string): ProjectDefaults {
  const has = (name: string) => existsSync(join(root, name));
  if (has("package.json") || LOCKFILES.some(([file]) => has(file))) return detectNode(root);
  if (has("go.mod")) return detectGo(root);
  if (has("Cargo.toml")) return detectRust(root);
  if (["pyproject.toml", "setup.py", "setup.cfg"].some(has) || readdirSync(root).some((f) => /^requirements.*\.txt$/.test(f))) return detectPython(root);
  return detectUnknown();
}

/** 手動設定 test 指令就當作有測試框架 */
export const usesTestFramework = (raw: unknown, detected: ProjectDefaults): boolean =>
  detected.testFramework || (!!raw && typeof raw === "object" && "test" in raw);

/** 補上原始設定裡沒寫的 install、test、checks；不是物件就原樣回傳，交給 schema 報錯 */
export function withProjectDefaults(raw: unknown, detected: ProjectDefaults): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { install, test } = detected;
  // 沒有測試框架也沒手動設定 test 時，預設的檢查不含 test
  let checks = usesTestFramework(raw, detected) ? detected.checks : detected.checks.filter((c) => c.name !== "test");
  // 未知專案沒有偵測到任何檢查：手寫了 test 卻沒寫 checks 時，verify 也要跑它
  const hand = raw as Record<string, unknown>;
  if (detected.ecosystem === "unknown" && typeof hand.test === "string" && !("checks" in hand)) checks = [{ name: "test", cmd: hand.test }];
  return { install, test, checks, ...(detected.testPattern ? { testPattern: detected.testPattern } : {}), ...raw };
}

/** run 開始時印出的說明：只列出這次用了偵測結果的欄位 */
export function describeDetected(raw: Record<string, unknown>, detected: ProjectDefaults): string[] {
  const nothingDetected = detected.ecosystem === "unknown"
    || (detected.ecosystem === "generated" && detected.install === NO_INSTALL && !detected.testFramework && !detected.checks.length && !detected.testPattern);
  const framework = usesTestFramework(raw, detected);
  if (nothingDetected) {
    // 沒有任何偵測結果可說明：只有在手動設定也沒給出測試時才提醒
    if (framework || "checks" in raw) return [];
    const why = detected.ecosystem === "generated" ? "動態偵測沒有可用結果" : "沒有 package.json、go.mod、Cargo.toml、pyproject.toml 等";
    return [`ℹ️  未辨識專案類型（${why}），略過安裝、檢查與紅綠燈；在 flow.config.json 設定 install、test、checks 可改回來`];
  }
  const lines: string[] = [];
  if (!("install" in raw)) lines.push(`   install：${detected.install}`);
  if (!("test" in raw) && framework) lines.push(`   test：${detected.test}`);
  if (!("checks" in raw)) lines.push(...detected.checks.filter((c) => framework || c.name !== "test").map((c) => `   checks.${c.name}：${c.cmd}${c.finalOnly ? "（只在最後驗證，" + (c.changedOnly ? "只檢查改過的檔案）" : "整個專案）") : ""}`));
  if (!("testPattern" in raw) && detected.testPattern) lines.push(`   testPattern：${detected.testPattern}`);
  if (!framework) lines.push("ℹ️  未偵測到測試框架，所有任務略過紅綠燈，也不跑 test 檢查（在 flow.config.json 設定 test 可改回來）");
  if (!lines.length) return [];
  const why = detected.source === "預設" ? "預設" : `依 ${detected.source}`;
  return [`🔧 依專案偵測指令：${detected.manager}（${why}）`, ...lines];
}
