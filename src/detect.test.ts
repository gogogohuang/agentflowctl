import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDetected, detectProjectDefaults, findFiles, NO_INSTALL, withProjectDefaults } from "./detect.js";
import { ESLINT_IGNORE_ARGS, RepoConfig, VITEST_WORKTREE_EXCLUDES } from "./schemas.js";

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
    // 沒有 lint／typecheck script 就略過，不退回預設指令；非 Vite 專案也沒有 build script 時 build 同樣略過
    expect(d.checks).toEqual(defaults.checks.filter((c) => c.name === "test"));
  });

  it("有 package.json、沒有 build script 且不是 Vite 專案時略過 build，不退回 npx vite build", () => {
    const names = (files: Record<string, string | object>) => detectProjectDefaults(project(files)).checks.map((c) => c.name);
    expect(names({ "package.json": { scripts: { test: "node --test" } } })).toEqual(["test"]);
  });

  it("看得出是 Vite 專案時沒有 build script 仍跑預設的 vite build", () => {
    const names = (files: Record<string, string | object>) => detectProjectDefaults(project(files)).checks.map((c) => c.name);
    expect(names({ "package.json": { devDependencies: { vite: "^6" } } })).toContain("build");
    expect(names({ "package.json": {}, "vite.config.ts": "" })).toContain("build");
    expect(names({ "package.json": {}, "index.html": "" })).toContain("build");
  });

  it("有 build script 時一律跑它；空資料夾是未知類型，不跑任何檢查", () => {
    const d = detectProjectDefaults(project({ "package.json": { scripts: { build: "tsc" } } }));
    expect(d.checks.find((c) => c.name === "build")?.cmd).toBe("npm run build");
    expect(detectProjectDefaults(project({})).checks).toEqual([]);
  });

  it("依依賴與 test script 判斷有沒有測試框架", () => {
    expect(detectProjectDefaults(project({ "package.json": {} })).testFramework).toBe(false);
    expect(detectProjectDefaults(project({})).testFramework).toBe(false);
    expect(detectProjectDefaults(project({ "package.json": { devDependencies: { vitest: "^3" } } })).testFramework).toBe(true);
    expect(detectProjectDefaults(project({ "package.json": { dependencies: { jest: "^29" } } })).testFramework).toBe(true);
    expect(detectProjectDefaults(project({ "package.json": { scripts: { test: "node --test" } } })).testFramework).toBe(true);
    const placeholder = 'echo "Error: no test specified" && exit 1';
    expect(detectProjectDefaults(project({ "package.json": { scripts: { test: placeholder } } })).testFramework).toBe(false);
  });

  it("只有 lockfile 沒有 package.json 時仍回傳 npm 的預設值", () => {
    const d = detectProjectDefaults(project({ "package-lock.json": "{}" }));
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
    expect(d.test).toBe(`pnpm exec vitest run ${VITEST_WORKTREE_EXCLUDES}`);
    expect(d.checks).toEqual([
      { name: "test", cmd: `pnpm exec vitest run ${VITEST_WORKTREE_EXCLUDES}` },
      { name: "build", cmd: "pnpm exec vite build" },
    ]);
  });

  it("yarn 與 bun 的指令寫法", () => {
    const yarn = detectProjectDefaults(project({ "yarn.lock": "" }));
    expect(yarn.install).toBe("yarn install");
    expect(yarn.test).toBe(`yarn vitest run ${VITEST_WORKTREE_EXCLUDES}`);
    const bun = detectProjectDefaults(project({ "bun.lock": "" }));
    expect(bun.install).toBe("bun install");
    expect(bun.test).toBe(`bunx vitest run ${VITEST_WORKTREE_EXCLUDES}`);
  });

  it("package.json 有對應的 script 時改用 run <script>", () => {
    const d = detectProjectDefaults(project({
      "pnpm-lock.yaml": "",
      "package.json": { scripts: { "type-check": "tsc -b", lint: "eslint .", test: "vitest run", build: "tsc -b && vite build" } },
    }));
    expect(d.checks).toEqual([
      { name: "typecheck", cmd: "pnpm run type-check", finalOnly: true },
      { name: "lint", cmd: `pnpm run lint ${ESLINT_IGNORE_ARGS}`, finalOnly: true, changedOnly: true },
      { name: "test", cmd: `pnpm run test ${VITEST_WORKTREE_EXCLUDES}` },
      { name: "build", cmd: "pnpm run build" },
    ]);
  });

  it("lint script 是 eslint 時補上略過 .flow 與 .agentflowctl，npm 要加 --", () => {
    const d = detectProjectDefaults(project({ "package.json": { scripts: { lint: "eslint ." } } }));
    expect(d.checks.find((c) => c.name === "lint")?.cmd).toBe(`npm run lint -- ${ESLINT_IGNORE_ARGS}`);
  });

  it("lint script 不是 eslint 時不動指令", () => {
    const d = detectProjectDefaults(project({ "pnpm-lock.yaml": "", "package.json": { scripts: { lint: "biome check ." } } }));
    expect(d.checks.find((c) => c.name === "lint")?.cmd).toBe("pnpm run lint");
  });

  it("test script 不是 vitest 時不附加 vitest 的排除", () => {
    const d = detectProjectDefaults(project({ "pnpm-lock.yaml": "", "package.json": { scripts: { test: "jest" } } }));
    expect(d.checks.find((c) => c.name === "test")?.cmd).toBe("pnpm run test");
    expect(d.test).toBe("pnpm run test");
  });

  it("專案有 test script 時，紅綠燈用的 test 指令也跑它（例如 node:test 專案不能被 vitest 接手）", () => {
    const d = detectProjectDefaults(project({ "package.json": { scripts: { test: "node --test cli/*.test.js" } } }));
    expect(d.test).toBe("npm run test");
  });

  it("test script 是 vitest 時，紅綠燈的 test 指令附加排除；佔位 script 與沒有 script 時維持預設 vitest", () => {
    expect(detectProjectDefaults(project({ "package.json": { scripts: { test: "vitest run" } } })).test).toBe(`npm run test -- ${VITEST_WORKTREE_EXCLUDES}`);
    expect(detectProjectDefaults(project({ "package.json": { scripts: { test: 'echo "Error: no test specified" && exit 1' } } })).test).toBe(`npx vitest run ${VITEST_WORKTREE_EXCLUDES}`);
    expect(detectProjectDefaults(project({ "package.json": {} })).test).toBe(`npx vitest run ${VITEST_WORKTREE_EXCLUDES}`);
  });

  it("typecheck 也認得不含連字號的 script 名稱", () => {
    const d = detectProjectDefaults(project({ "package.json": { scripts: { typecheck: "tsc --noEmit" } } }));
    expect(d.checks[0]).toEqual({ name: "typecheck", cmd: "npm run typecheck", finalOnly: true });
  });

  it("package.json 不是合法 JSON 時退回 lockfile 判斷", () => {
    const d = detectProjectDefaults(project({ "package.json": "{", "pnpm-lock.yaml": "" }));
    expect(d.manager).toBe("pnpm");
  });
  it("沒有任何可辨識的專案檔（含空資料夾）時是未知類型：不安裝、沒有檢查、不走紅綠燈", () => {
    const d = detectProjectDefaults(project({ "README.md": "# hi" }));
    expect(d.ecosystem).toBe("unknown");
    expect(d.install).toBe(NO_INSTALL);
    expect(d.checks).toEqual([]);
    expect(d.testFramework).toBe(false);
    expect(d.testPattern).toBeUndefined();
  });

  it("只有 Node lockfile 沒有 package.json 仍視為 Node 專案", () => {
    expect(detectProjectDefaults(project({ "pnpm-lock.yaml": "" })).ecosystem).toBe("node");
  });

  it("findFiles 略過 node_modules、.git、.agentflowctl 等目錄，並回傳以 / 分隔的相對路徑", () => {
    const dir = project({ "a_test.go": "" });
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "b_test.go"), "");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "c_test.go"), "");
    expect(findFiles(dir, /_test\.go$/).sort()).toEqual(["a_test.go", "pkg/b_test.go"]);
  });
});

describe("detectProjectDefaults：Go 與 Rust", () => {
  it("Go：go.mod 加上既有的 *_test.go 視為有測試框架", () => {
    const d = detectProjectDefaults(project({ "go.mod": "module x\n", "a_test.go": "" }));
    expect(d.ecosystem).toBe("go");
    expect(d.install).toBe("go mod download");
    expect(d.test).toBe("go test ./...");
    expect(d.checks).toEqual([
      { name: "test", cmd: "go test ./..." },
      { name: "vet", cmd: "go vet ./...", finalOnly: true },
      { name: "build", cmd: "go build ./..." },
    ]);
    expect(d.testFramework).toBe(true);
    expect(new RegExp(d.testPattern!).test("pkg/a_test.go")).toBe(true);
    expect(new RegExp(d.testPattern!).test("pkg/a.go")).toBe(false);
  });

  it("Go：還沒有任何 *_test.go 時視為沒有測試框架（不走紅綠燈）", () => {
    expect(detectProjectDefaults(project({ "go.mod": "module x\n" })).testFramework).toBe(false);
  });

  it("Rust：Cargo.toml 加上 *_test.rs 視為有測試框架，沒有測試檔就沒有", () => {
    const d = detectProjectDefaults(project({ "Cargo.toml": "[package]\n", "a_test.rs": "" }));
    expect(d.ecosystem).toBe("rust");
    expect(d.install).toBe("cargo fetch");
    expect(d.checks).toEqual([
      { name: "test", cmd: "cargo test" },
      { name: "clippy", cmd: "cargo clippy", finalOnly: true },
      { name: "build", cmd: "cargo build" },
    ]);
    expect(d.testFramework).toBe(true);
    expect(new RegExp(d.testPattern!).test("tests/api.rs")).toBe(true);
    expect(new RegExp(d.testPattern!).test("src/lib.rs")).toBe(false);
    expect(detectProjectDefaults(project({ "Cargo.toml": "[package]\n" })).testFramework).toBe(false);
  });

  it("package.json 優先於其他專案檔（混合專案以 Node 為準）", () => {
    expect(detectProjectDefaults(project({ "package.json": {}, "go.mod": "module x\n" })).ecosystem).toBe("node");
  });
});

describe("detectProjectDefaults：Python", () => {
  const pyproject = (body: string) => ({ "pyproject.toml": body });

  it("pip 專案：有 requirements.txt 就裝它，pytest 出現在依賴裡視為有測試框架", () => {
    const d = detectProjectDefaults(project({ "requirements.txt": "pytest>=8\n" }));
    expect(d.ecosystem).toBe("python");
    expect(d.manager).toBe("pip");
    expect(d.install).toBe("pip install -r requirements.txt");
    expect(d.test).toBe("pytest");
    expect(d.checks).toEqual([{ name: "test", cmd: "pytest" }]);
    expect(d.testFramework).toBe(true);
  });

  it("只有 pyproject.toml 時用 pip install -e .", () => {
    expect(detectProjectDefaults(project(pyproject("[project]\nname='x'\n"))).install).toBe("pip install -e .");
  });

  it("uv 與 poetry：依 lockfile 選安裝與執行前綴", () => {
    const uv = detectProjectDefaults(project({ ...pyproject("[tool.pytest.ini_options]\n"), "uv.lock": "" }));
    expect(uv.manager).toBe("uv");
    expect(uv.install).toBe("uv sync");
    expect(uv.test).toBe("uv run pytest");
    const poetry = detectProjectDefaults(project({ ...pyproject("[tool.poetry]\n"), "poetry.lock": "", "test_a.py": "" }));
    expect(poetry.install).toBe("poetry install --no-interaction");
    expect(poetry.test).toBe("poetry run python -m unittest discover");
  });

  it("沒有測試框架字樣也沒有測試檔時視為沒有測試框架；有 test_*.py 就有", () => {
    expect(detectProjectDefaults(project(pyproject("[project]\nname='x'\n"))).testFramework).toBe(false);
    expect(detectProjectDefaults(project({ ...pyproject("[project]\nname='x'\n"), "test_a.py": "" })).testFramework).toBe(true);
  });

  it("pyproject 有 ruff 設定時加上只在最後驗證的 lint", () => {
    const d = detectProjectDefaults(project(pyproject("[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n")));
    expect(d.checks).toEqual([
      { name: "test", cmd: "pytest" },
      { name: "lint", cmd: "ruff check .", finalOnly: true },
    ]);
  });

  it("testPattern 認得 test_*.py 與 *_test.py", () => {
    const re = new RegExp(detectProjectDefaults(project(pyproject("[project]\n"))).testPattern!);
    expect(re.test("tests/test_a.py")).toBe(true);
    expect(re.test("pkg/a_test.py")).toBe(true);
    expect(re.test("pkg/a.py")).toBe(false);
  });
});

describe("withProjectDefaults", () => {
  const detected = detectProjectDefaults(project({ "pnpm-lock.yaml": "", "package.json": { devDependencies: { vitest: "^3" } } }));

  it("補上設定裡沒寫的 install、test、checks", () => {
    const raw = withProjectDefaults({ tddSplit: false }, detected) as Record<string, unknown>;
    expect(raw.install).toBe("pnpm install");
    expect(raw.test).toBe(`pnpm exec vitest run ${VITEST_WORKTREE_EXCLUDES}`);
    expect(raw.checks).toEqual(detected.checks);
    expect(raw.tddSplit).toBe(false);
  });

  it("手動設定的欄位不會被偵測結果蓋掉", () => {
    const checks = [{ name: "only", cmd: "make check" }];
    const raw = withProjectDefaults({ install: "make deps", checks }, detected) as Record<string, unknown>;
    expect(raw.install).toBe("make deps");
    expect(raw.checks).toEqual(checks);
    expect(raw.test).toBe(`pnpm exec vitest run ${VITEST_WORKTREE_EXCLUDES}`);
  });

  it("沒有測試框架且沒手動設定 test 時，預設 checks 不含 test", () => {
    const none = detectProjectDefaults(project({ "package.json": {} }));
    const raw = withProjectDefaults({}, none) as { checks: { name: string }[] };
    expect(raw.checks.map((c) => c.name)).not.toContain("test");
    const manual = withProjectDefaults({ test: "make test" }, none) as { checks: { name: string }[] };
    expect(manual.checks.map((c) => c.name)).toContain("test");
  });

  it("不是物件時原樣回傳，交給 schema 報錯", () => {
    expect(withProjectDefaults([], detected)).toEqual([]);
    expect(withProjectDefaults(null, detected)).toBeNull();
  });

  it("偵測有 testPattern 時補上，手寫的 testPattern 優先", () => {
    const go = detectProjectDefaults(project({ "go.mod": "module x\n" }));
    expect((withProjectDefaults({}, go) as { testPattern?: string }).testPattern).toBe(go.testPattern);
    expect((withProjectDefaults({ testPattern: "x" }, go) as { testPattern?: string }).testPattern).toBe("x");
    const node = detectProjectDefaults(project({ "package.json": {} }));
    expect("testPattern" in (withProjectDefaults({}, node) as object)).toBe(false);
  });
});

describe("describeDetected", () => {
  const detected = detectProjectDefaults(project({ "pnpm-lock.yaml": "", "package.json": { devDependencies: { vitest: "^3" } } }));

  it("列出這次改用偵測結果的欄位", () => {
    expect(describeDetected({ checks: [] }, detected)).toEqual([
      "🔧 依專案偵測指令：pnpm（依 pnpm-lock.yaml）",
      "   install：pnpm install",
      `   test：pnpm exec vitest run ${VITEST_WORKTREE_EXCLUDES}`,
    ]);
  });

  it("checks 逐項列出", () => {
    const lines = describeDetected({ install: "x", test: "y" }, detected);
    expect(lines.slice(1)).toEqual(detected.checks.map((c) => `   checks.${c.name}：${c.cmd}`));
  });

  it("沒有測試框架時說明會略過紅綠燈", () => {
    const none = detectProjectDefaults(project({ "package.json": {} }));
    expect(describeDetected({ install: "x", checks: [] }, none).join("\n")).toContain("未偵測到測試框架");
    expect(describeDetected({ install: "x", test: "y", checks: [] }, none)).toEqual([]);
  });

  it("三個欄位都手動設定時不輸出", () => {
    expect(describeDetected({ install: "x", test: "y", checks: [] }, detected)).toEqual([]);
  });

  it("非 Node 專案會列出偵測到的 testPattern", () => {
    const go = detectProjectDefaults(project({ "go.mod": "module x\n" }));
    expect(describeDetected({}, go).some((l) => l.includes("testPattern") && l.includes("_test"))).toBe(true);
    expect(describeDetected({ testPattern: "x" }, go).some((l) => l.includes("testPattern"))).toBe(false);
  });
});
