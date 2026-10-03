# 多語言專案偵測（混合式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 agentflowctl 依專案實際狀態（Node、Python、Go、Rust，其餘由 agent 動態產生並經程式驗證）決定 install／test／checks／testPattern 與是否走 TDD，不再預設 Node。

**Architecture:** `detect.ts` 拆成各類型的純函式偵測，回傳 `ProjectDefaults`（多了 `ecosystem`、`testPattern`）。未知類型在 run 開始時由 `detectWithAgent` 請一位 agent 提出 JSON 提案，`validateProposal` 在臨時 worktree 逐欄位驗證（基底必須綠），通過的欄位存進專案層級 `.agentflowctl/detected.json`；`effectiveDefaults(root)` 把它疊在內建偵測上，`loadRepoConfig()` 維持同步。手寫 `flow.config.json` 永遠優先。

**Tech Stack:** TypeScript（ESM、`.js` import 後綴）、zod、vitest、Node >= 22。

**Spec:** `docs/superpowers/specs/2026-10-03-multi-ecosystem-detect-design.md`

## Global Constraints

- 程式碼、註解、prompt、commit 訊息與使用者看到的輸出一律用繁體中文。
- 新增 `FlowRun` 以外的狀態不需要；若動到 `FlowRun`，新欄位必須 optional（本計畫不動）。
- 使用者看得到的行為變更，要在同一個 commit 更新 `README.md`（Task 7、Task 8 負責）。
- 關卡以程式能檢查的事實為準（跑指令、看結束碼），不依賴 agent 自述。
- 指令用 `pnpm test`／`npx vitest run <檔案>`、`pnpm run typecheck`。測試檔與原始碼放一起（`src/**/*.test.ts`）。
- commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 工作分支：`feat/multi-ecosystem-detect`（已存在，spec 與本計畫都在上面）。

## File Structure

| 檔案 | 職責 |
|---|---|
| `src/detect.ts`（改） | 各類型內建偵測（Node 沿用、新增 Go／Rust／Python／未知）、`findFiles`、`NO_INSTALL`、`Ecosystem`、`testPattern` 併入 `withProjectDefaults`、`describeDetected` |
| `src/detectedFile.ts`（新） | `detected.json` 的讀寫、`detectFingerprint`、`effectiveDefaults`（內建 + 動態結果疊加） |
| `src/generateDetected.ts`（新） | `validateProposal`：逐欄位驗證動態提案（依賴注入，不碰 agent） |
| `src/schemas.ts`（改） | 新增 `DetectionProposal`、`DetectedFile` |
| `src/paths.ts`（改） | 新增 `detectedPath()` |
| `src/engine.ts`（改） | `loadRepoConfig`／`hasTestFramework` 改用 `effectiveDefaults`；新增並匯出 `detectWithAgent(run)` |
| `src/cli.ts`（改） | `run` 指令在安裝前呼叫 `detectWithAgent`，並改用 `effectiveDefaults` |
| `prompts/detect.md`（新） | 請 agent 產出 `.flow/detect-proposal.json` |
| `src/*.test.ts` | 對應測試 |
| `README.md`、`docs/workflow.md`、`docs/configuration.md` | 說明 |

---

## Part 1：內建偵測

### Task 1：`ProjectDefaults` 擴充與「未知類型」

**Files:**
- Modify: `src/detect.ts`
- Test: `src/detect.test.ts`

**Interfaces:**
- Produces:
  - `export type Ecosystem = "node" | "python" | "go" | "rust" | "unknown" | "generated"`
  - `ProjectDefaults` 新增 `ecosystem: Ecosystem`、`testPattern?: string`，`manager` 型別由 `PackageManager` 放寬為 `string`
  - `export const NO_INSTALL = "true"`
  - `export function findFiles(root: string, re: RegExp, max?: number): string[]`（有界遞迴，回傳相對路徑，以 `/` 分隔）
  - `detectProjectDefaults(root)` 變成分派器：`package.json` 或任一 Node lockfile → Node；`go.mod` → Go；`Cargo.toml` → Rust；`pyproject.toml`／`setup.py`／`setup.cfg`／`requirements*.txt` → Python；否則 → 未知

- [ ] **Step 1: 寫失敗測試**

在 `src/detect.test.ts` 的 `describe("detectProjectDefaults"` 區塊最後加入，並**修改** PR #71 留下的 `"有 build script 時一律跑它；沒有 package.json 的全新專案維持預設 build"` 測試（見下方「替換」）：

```ts
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
```

替換 PR #71 的測試最後一行：

```ts
    // 原本：expect(detectProjectDefaults(project({})).checks.some((c) => c.name === "build")).toBe(true);
    expect(detectProjectDefaults(project({})).checks).toEqual([]);
```
並把該測試標題改為 `"有 build script 時一律跑它；空資料夾是未知類型，不跑任何檢查"`。

同時把檔案頂端 import 改成：

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
...
import { describeDetected, detectProjectDefaults, findFiles, NO_INSTALL, withProjectDefaults } from "./detect.js";
```

另外有兩個既有測試假設「沒有 package.json 也有 Node 預設」，一併改成給 lockfile：
- `"沒有 package.json 時仍回傳 npm 的預設值"`：改成 `project({ "package-lock.json": "{}" })`，標題改為 `"只有 lockfile 沒有 package.json 時仍回傳 npm 的預設值"`。
- `"依 lockfile 判斷套件管理器"`、`"pnpm 專案…"`、`"yarn 與 bun…"` 都已經用 lockfile，不用改。

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/detect.test.ts`
Expected: FAIL（`findFiles`、`NO_INSTALL` 未匯出；未知類型測試失敗）

- [ ] **Step 3: 實作**

在 `src/detect.ts`：

1. import 改為：
```ts
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
```
2. 型別與常數（取代原本的 `ProjectDefaults` 介面）：
```ts
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
}

/** 不需要安裝時的指令：install 在 `&&` 串接裡也要是合法的 shell */
export const NO_INSTALL = "true";
```
3. 把原本的 `export function detectProjectDefaults(root: string): ProjectDefaults {` 改名為 `function detectNode(root: string): ProjectDefaults {`，回傳物件加上 `ecosystem: "node"`：
```ts
  return { ecosystem: "node", manager, source, install: INSTALL[manager], test, checks, testFramework: hasTestFramework(pkg) };
```
4. 加入 `findFiles`、未知類型與分派器（放在 `detectNode` 後面）：
```ts
const SKIP_DIRS = new Set(["node_modules", ".git", ".agentflowctl", ".flow", ".worktree", ".worktrees", "venv", ".venv", "target", "dist", "build", "__pycache__"]);

/** 有界遞迴找出符合的檔案（深度 6、最多看 5000 個檔），略過依賴與建置產物目錄 */
export function findFiles(root: string, re: RegExp, max = 5000): string[] {
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
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), path, depth + 1);
      } else {
        visited++;
        if (re.test(path)) found.push(path);
      }
    }
  };
  walk(root, "", 0);
  return found;
}

function detectUnknown(): ProjectDefaults {
  return { ecosystem: "unknown", manager: "（未辨識）", source: "沒有可辨識的專案檔", install: NO_INSTALL, test: NO_INSTALL, checks: [], testFramework: false };
}

export function detectProjectDefaults(root: string): ProjectDefaults {
  const has = (name: string) => existsSync(join(root, name));
  if (has("package.json") || LOCKFILES.some(([file]) => has(file))) return detectNode(root);
  return detectUnknown();
}
```
（Go／Rust／Python 分支在 Task 2、3 加進分派器。）

5. `describeDetected` 開頭加上未知類型的說明（`const lines` 之前）：
```ts
  if (detected.ecosystem === "unknown" && !("install" in raw) && !("test" in raw) && !("checks" in raw)) {
    return ["ℹ️  未辨識專案類型（沒有 package.json、go.mod、Cargo.toml、pyproject.toml 等），略過安裝、檢查與紅綠燈；在 flow.config.json 設定 install、test、checks 可改回來"];
  }
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/detect.test.ts && pnpm run typecheck`
Expected: PASS；typecheck 若因 `manager` 型別放寬報錯，把 `describeDetected` 內用到 `detected.manager` 的地方保持字串即可（不需要型別轉換）。

- [ ] **Step 5: 全套測試找出被「空資料夾不再有 Node 預設」影響的既有測試**

Run: `pnpm test 2>&1 | tail -40`
Expected: 若有失敗，原因只會是測試用的臨時 git repo 沒有 package.json 而依賴舊預設（`engine.test.ts` 等）。處理方式：該測試的 `flow.config.json` 明寫它需要的 `install`／`test`／`checks`；不要改回預設。逐一修到全綠。

- [ ] **Step 6: Commit**

```bash
git add src/detect.ts src/detect.test.ts
git commit -m "偵測改成依專案類型分派，空資料夾視為未知類型"
```
（commit 訊息加上 Co-Authored-By 行；若 Step 5 改了其他測試檔，一併 `git add`。）

---

### Task 2：Go 與 Rust 偵測

**Files:**
- Modify: `src/detect.ts`
- Test: `src/detect.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `findFiles`、`ProjectDefaults`、分派器
- Produces: `detectGo(root)`、`detectRust(root)`（模組內部函式，經分派器使用）

- [ ] **Step 1: 寫失敗測試**

```ts
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/detect.test.ts -t "Go 與 Rust"`
Expected: FAIL（`ecosystem` 為 `"unknown"`）

- [ ] **Step 3: 實作**（加在 `detectUnknown` 前面，並更新分派器）

```ts
const GO_TEST_PATTERN = String.raw`_test\.go$`;
const RUST_TEST_PATTERN = String.raw`(^|/)tests/.*\.rs$|_test\.rs$`;

function detectGo(root: string): ProjectDefaults {
  return {
    ecosystem: "go", manager: "go", source: "go.mod",
    install: "go mod download", test: "go test ./...",
    checks: [
      { name: "test", cmd: "go test ./..." },
      { name: "vet", cmd: "go vet ./...", finalOnly: true },
      { name: "build", cmd: "go build ./..." },
    ],
    testFramework: findFiles(root, new RegExp(GO_TEST_PATTERN)).length > 0,
    testPattern: GO_TEST_PATTERN,
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
    testFramework: findFiles(root, new RegExp(RUST_TEST_PATTERN)).length > 0,
    testPattern: RUST_TEST_PATTERN,
  };
}
```

分派器在 Node 判斷之後加：
```ts
  if (has("go.mod")) return detectGo(root);
  if (has("Cargo.toml")) return detectRust(root);
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/detect.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: 確認檢查名稱沒有其他地方依賴固定集合**

Run: `grep -rn '"vet"\|"clippy"\|c.name ===\|check.name ===' src/*.ts | grep -v test.ts`
Expected: 只有 `detect.ts` 內 `name === "test"` 等既有用法；`engine.ts` 以 `finalOnly`／`changedOnly` 欄位決定行為，不看名稱。若發現依賴名稱的邏輯，改成用欄位判斷。

- [ ] **Step 6: Commit**

```bash
git add src/detect.ts src/detect.test.ts
git commit -m "新增 Go 與 Rust 專案偵測與測試框架判定"
```

---

### Task 3：Python 偵測

**Files:**
- Modify: `src/detect.ts`
- Test: `src/detect.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `findFiles`、分派器

- [ ] **Step 1: 寫失敗測試**

```ts
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/detect.test.ts -t "Python"`
Expected: FAIL

- [ ] **Step 3: 實作**（加在 `detectRust` 後面，並更新分派器）

```ts
const PYTHON_TEST_PATTERN = String.raw`(^|/)(test_[^/]*|[^/]*_test)\.py$`;

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
        ? ["pip", "requirements.txt", "pip install -r requirements.txt", ""]
        : ["pip", "pyproject.toml／setup.py", "pip install -e .", ""];
  const pytest = /\bpytest\b/.test(config) || has("pytest.ini") || has("conftest.py");
  const unittest = /\bunittest\b/.test(config);
  const testFiles = findFiles(root, new RegExp(PYTHON_TEST_PATTERN));
  const test = `${run}${pytest ? "pytest" : "python -m unittest discover"}`;
  const checks: Check[] = [{ name: "test", cmd: test }];
  if (/\[tool\.ruff/.test(text("pyproject.toml")) || has("ruff.toml") || has(".ruff.toml")) {
    checks.push({ name: "lint", cmd: `${run}ruff check .`, finalOnly: true });
  }
  return { ecosystem: "python", manager, source, install, test, checks, testFramework: pytest || unittest || testFiles.length > 0, testPattern: PYTHON_TEST_PATTERN };
}
```

分派器在 Rust 判斷之後加：
```ts
  if (["pyproject.toml", "setup.py", "setup.cfg"].some(has) || readdirSync(root).some((f) => /^requirements.*\.txt$/.test(f))) return detectPython(root);
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/detect.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/detect.ts src/detect.test.ts
git commit -m "新增 Python 專案偵測與測試框架判定"
```

---

### Task 4：`testPattern` 併入設定與說明

**Files:**
- Modify: `src/detect.ts`（`withProjectDefaults`、`describeDetected`）
- Test: `src/detect.test.ts`

**Interfaces:**
- Consumes: `ProjectDefaults.testPattern`
- Produces: `withProjectDefaults` 在偵測有 `testPattern` 且手寫沒寫時補上；`describeDetected` 多印一行

- [ ] **Step 1: 寫失敗測試**

在 `describe("withProjectDefaults"` 與 `describe("describeDetected"` 各加：

```ts
  it("偵測有 testPattern 時補上，手寫的 testPattern 優先", () => {
    const go = detectProjectDefaults(project({ "go.mod": "module x\n" }));
    expect((withProjectDefaults({}, go) as { testPattern?: string }).testPattern).toBe(go.testPattern);
    expect((withProjectDefaults({ testPattern: "x" }, go) as { testPattern?: string }).testPattern).toBe("x");
    const node = detectProjectDefaults(project({ "package.json": {} }));
    expect("testPattern" in (withProjectDefaults({}, node) as object)).toBe(false);
  });
```
```ts
  it("非 Node 專案會列出偵測到的 testPattern", () => {
    const go = detectProjectDefaults(project({ "go.mod": "module x\n" }));
    expect(describeDetected({}, go).some((l) => l.includes("testPattern") && l.includes("_test"))).toBe(true);
    expect(describeDetected({ testPattern: "x" }, go).some((l) => l.includes("testPattern"))).toBe(false);
  });
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/detect.test.ts -t "testPattern"`
Expected: FAIL

- [ ] **Step 3: 實作**

`withProjectDefaults` 最後一行改成：
```ts
  return { install, test, checks, ...(detected.testPattern ? { testPattern: detected.testPattern } : {}), ...raw };
```
`describeDetected` 在 `checks` 那行之後加：
```ts
  if (!("testPattern" in raw) && detected.testPattern) lines.push(`   testPattern：${detected.testPattern}`);
```

- [ ] **Step 4: 執行確認通過，並確認 prompt 已使用 `{{testPattern}}`**

Run: `npx vitest run src/detect.test.ts && grep -rn "vitest\|\.test\.ts" prompts/ | head`
Expected: PASS；grep 若在 prompt 內發現寫死的 JS/TS 假設（例如「用 vitest」），改成通用說法（`prompts/implement-tests.md` 等）。沒有就不用改。

- [ ] **Step 5: Commit**

```bash
git add src/detect.ts src/detect.test.ts prompts
git commit -m "偵測到的 testPattern 併入設定並列在偵測說明"
```

---

### Task 5：Part 1 文件與全套驗證

**Files:**
- Modify: `README.md`（第 121 行附近「`install`、`test`、`checks` 未設定時會依專案自動偵測」那段）、`docs/workflow.md`（第 52 行那段「專案指令偵測」）、`docs/configuration.md`（第 216 行附近）

- [ ] **Step 1: 更新文件**

`README.md` 該段改成：

```markdown
`install`、`test`、`checks`、`testPattern` 未設定時會依專案自動偵測：Node（`package.json`、lockfile）、Python（`pyproject.toml`、`requirements*.txt`）、Go（`go.mod`）、Rust（`Cargo.toml`）。專案沒有測試框架（Node 沒有測試依賴或 `test` script；Python 沒有 pytest／unittest 且沒有測試檔；Go、Rust 還沒有任何測試檔）時，所有任務不走紅綠燈，也不跑 `test` 檢查。專案有 `test` script 時，紅綠燈與 `checks.test` 都跑它。認不出類型的專案不安裝、不跑檢查，需要時在 `flow.config.json` 設定。偵測到的 vitest 會略過 `.worktree/` 與 `.worktrees/`；eslint 的 lint 會略過 `.flow/`、`.agentflowctl/`、`.worktree/`、`.worktrees/`。（保留原本接著的「完整欄位…」句子。）
```
`docs/workflow.md` 在「專案指令偵測」段尾加一段：各類型的 install／test／checks／testPattern 表（照本計畫 spec 的「內建偵測」表）與「測試框架判定」表，並註明 Rust 單元測試寫在原始碼內時可能被判定沒寫測試。`docs/configuration.md` 該段補上 `testPattern` 也可由偵測補上。

- [ ] **Step 2: 全套驗證**

Run: `pnpm run typecheck && pnpm test 2>&1 | tail -8`
Expected: 全過

- [ ] **Step 3: Commit**

```bash
git add README.md docs
git commit -m "文件：說明多語言偵測與測試框架判定"
```

---

## Part 2：動態產生

### Task 6：`DetectedFile`、指紋與 `effectiveDefaults`

**Files:**
- Modify: `src/schemas.ts`、`src/paths.ts`、`src/engine.ts`（`loadRepoConfig`、`hasTestFramework`）、`src/cli.ts`（一處）
- Create: `src/detectedFile.ts`
- Test: `src/detectedFile.test.ts`

**Interfaces:**
- Produces:
  - `schemas.ts`：`DetectionProposal`（`{ install?, test?, checks: {name, cmd, finalOnly?}[] , testPattern? }`）、`DetectedFile`（提案欄位 ＋ `fingerprint`、`generatedAt`、`dropped: {field, reason}[]`）及其型別
  - `paths.ts`：`export const detectedPath = () => join(agentflowctlDir(), "detected.json")`
  - `detectedFile.ts`：`detectFingerprint(root: string): string`、`readDetected(root: string): DetectedFile | undefined`、`writeDetected(root: string, file: DetectedFile): void`、`effectiveDefaults(root: string): ProjectDefaults`、`overlayGenerated(base: ProjectDefaults, g: DetectedFile): ProjectDefaults`
  - `readDetected` 以 `root` 參數定位檔案（`join(root, ".agentflowctl", "detected.json")`），讓測試不需要 chdir；`detectedPath()` 供 `dump`／文件使用，兩者路徑一致。

- [ ] **Step 1: 寫失敗測試**（`src/detectedFile.test.ts`）

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectFingerprint, effectiveDefaults, overlayGenerated, readDetected, writeDetected } from "./detectedFile.js";
import { detectProjectDefaults, NO_INSTALL } from "./detect.js";
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
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/detectedFile.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**

`src/schemas.ts`（加在 `RepoConfig` 之後）：
```ts
/** agent 對未知類型專案提出的指令；尚未經程式驗證 */
export const DetectionProposal = z.object({
  install: z.string().optional(),
  test: z.string().optional(),
  checks: z.array(z.object({ name: z.string(), cmd: z.string(), finalOnly: z.boolean().optional() })).default([]),
  testPattern: z.string().optional(),
});
export type DetectionProposal = z.infer<typeof DetectionProposal>;

/** `.agentflowctl/detected.json`：通過驗證的欄位，以及被丟掉的欄位與原因；沒有的欄位代表沒有可用的結果 */
export const DetectedFile = DetectionProposal.extend({
  fingerprint: z.string(),
  generatedAt: z.string(),
  dropped: z.array(z.object({ field: z.string(), reason: z.string() })).default([]),
});
export type DetectedFile = z.infer<typeof DetectedFile>;
```

`src/paths.ts`（加在 `runsDir` 後面）：
```ts
/** 動態偵測的結果；專案層級，不屬於單一 run */
export const detectedPath = () => join(agentflowctlDir(), "detected.json");
```

`src/detectedFile.ts`：
```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectProjectDefaults, NO_INSTALL, type ProjectDefaults } from "./detect.js";
import { DetectedFile } from "./schemas.js";

/** 判斷未知類型專案「有沒有變」的特徵檔：內容都納入指紋 */
const FINGERPRINT_FILES = ["Makefile", "justfile", "CMakeLists.txt", "pom.xml", "Gemfile", "composer.json", "mix.exs"];
const FINGERPRINT_PATTERNS = [/^build\.gradle/, /\.sln$/, /\.csproj$/];

const detectedFile = (root: string) => join(root, ".agentflowctl", "detected.json");

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function detectFingerprint(root: string): string {
  const names = new Set(FINGERPRINT_FILES);
  try {
    for (const f of readdirSync(root)) if (FINGERPRINT_PATTERNS.some((re) => re.test(f))) names.add(f);
  } catch {
    // 讀不到目錄就只看固定的檔名
  }
  const parts = [...names].sort().map((name) => `${name}\n${readText(join(root, name))}`);
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f)).sort()) parts.push(`.github/workflows/${f}\n${readText(join(workflows, f))}`);
  }
  return createHash("sha1").update(parts.join("\n--\n")).digest("hex");
}

export function readDetected(root: string): DetectedFile | undefined {
  try {
    const parsed = DetectedFile.safeParse(JSON.parse(readFileSync(detectedFile(root), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 原子寫入：先寫暫存檔再改名，中斷時不會留下半份 JSON */
export function writeDetected(root: string, file: DetectedFile): void {
  const path = detectedFile(root);
  mkdirSync(join(root, ".agentflowctl"), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

export function overlayGenerated(base: ProjectDefaults, g: DetectedFile): ProjectDefaults {
  return {
    ...base,
    ecosystem: "generated",
    manager: "動態偵測",
    source: ".agentflowctl/detected.json",
    install: g.install ?? NO_INSTALL,
    test: g.test ?? base.test,
    checks: [...(g.test ? [{ name: "test", cmd: g.test }] : []), ...g.checks],
    testFramework: g.test !== undefined,
    testPattern: g.testPattern,
  };
}

/** 內建偵測；只有未知類型且 detected.json 的指紋相符時，才疊上動態產生的結果 */
export function effectiveDefaults(root: string): ProjectDefaults {
  const base = detectProjectDefaults(root);
  if (base.ecosystem !== "unknown") return base;
  const generated = readDetected(root);
  return generated && generated.fingerprint === detectFingerprint(root) ? overlayGenerated(base, generated) : base;
}
```

`src/engine.ts`：`./detect.js` 的 import 維持 `import { detectProjectDefaults, usesTestFramework, withProjectDefaults } from "./detect.js";`（Task 8 的 `detectWithAgent` 還會用 `detectProjectDefaults`），並新增 `import { effectiveDefaults } from "./detectedFile.js";`，然後把 `loadRepoConfig` 的 `const detected = detectProjectDefaults(root);` 與 `hasTestFramework` 內的 `detectProjectDefaults(root)` 都換成 `effectiveDefaults(root)`。

`src/cli.ts`：第 13 行 import 改成 `import { describeDetected } from "./detect.js"; import { effectiveDefaults } from "./detectedFile.js";`，第 213 行的 `detectProjectDefaults(root)` 換成 `effectiveDefaults(root)`（Task 8 會再改這一帶）。

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/detectedFile.test.ts src/detect.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/paths.ts src/detectedFile.ts src/detectedFile.test.ts src/engine.ts src/cli.ts
git commit -m "新增 detected.json 與 effectiveDefaults：未知類型疊上動態偵測結果"
```

---

### Task 7：`validateProposal`（逐欄位驗證）

**Files:**
- Create: `src/generateDetected.ts`
- Test: `src/generateDetected.test.ts`

**Interfaces:**
- Consumes: `DetectionProposal`、`DetectedFile`（Task 6）
- Produces:
```ts
export interface ValidateDeps {
  /** 在臨時 worktree 內跑指令；逾時要回傳 ok: false */
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  /** 臨時 worktree 內追蹤檔的相對路徑 */
  files: string[];
  /** 指令的第一個可執行檔是否存在 */
  hasExecutable(bin: string): boolean;
}
export type Validated = Pick<DetectedFile, "install" | "test" | "checks" | "testPattern" | "dropped">;
export async function validateProposal(p: DetectionProposal, deps: ValidateDeps): Promise<Validated>
export function isTrivialCommand(cmd: string): boolean
export function firstExecutable(cmd: string): string | undefined
```

- [ ] **Step 1: 寫失敗測試**（`src/generateDetected.test.ts`）

```ts
import { describe, expect, it } from "vitest";
import { firstExecutable, isTrivialCommand, validateProposal, type ValidateDeps } from "./generateDetected.js";

const deps = (over: Partial<ValidateDeps> & { fail?: string[] } = {}): ValidateDeps & { ran: string[] } => {
  const ran: string[] = [];
  return {
    ran,
    files: [],
    hasExecutable: () => true,
    run: async (cmd) => { ran.push(cmd); return { ok: !over.fail?.includes(cmd), output: "" }; },
    ...over,
  };
};

describe("isTrivialCommand／firstExecutable", () => {
  it("空指令與永遠成功的指令視為無效", () => {
    for (const c of ["", "  ", "true", ":", "exit 0", "echo ok", "echo 'all good'"]) expect(isTrivialCommand(c)).toBe(true);
    for (const c of ["make test", "go test ./...", "true && make test"]) expect(isTrivialCommand(c)).toBe(false);
  });

  it("取第一個可執行檔，略過 VAR=值 的環境變數前綴", () => {
    expect(firstExecutable("make test")).toBe("make");
    expect(firstExecutable("CI=1 FOO=bar npm test")).toBe("npm");
    expect(firstExecutable("   ")).toBeUndefined();
  });
});

describe("validateProposal", () => {
  it("全部通過時原樣保留，且先 install 再 test 再 checks", async () => {
    const d = deps();
    const out = await validateProposal({ install: "make deps", test: "make test", checks: [{ name: "lint", cmd: "make lint", finalOnly: true }], testPattern: "_spec\\.rb$" }, d);
    expect(out).toEqual({ install: "make deps", test: "make test", checks: [{ name: "lint", cmd: "make lint", finalOnly: true }], testPattern: "_spec\\.rb$", dropped: [] });
    expect(d.ran).toEqual(["make deps", "make test", "make lint"]);
  });

  it("test 在基底上沒通過就丟掉（視為沒有測試框架），其餘欄位不受影響", async () => {
    const out = await validateProposal({ install: "make deps", test: "make test", checks: [{ name: "build", cmd: "make build" }] }, deps({ fail: ["make test"] }));
    expect(out.test).toBeUndefined();
    expect(out.install).toBe("make deps");
    expect(out.checks).toEqual([{ name: "build", cmd: "make build" }]);
    expect(out.dropped).toEqual([{ field: "test", reason: "在基底上沒有通過：make test" }]);
  });

  it("只丟掉壞的那一項 check", async () => {
    const out = await validateProposal({ checks: [{ name: "a", cmd: "make a" }, { name: "b", cmd: "make b" }] }, deps({ fail: ["make a"] }));
    expect(out.checks).toEqual([{ name: "b", cmd: "make b" }]);
    expect(out.dropped.map((x) => x.field)).toEqual(["checks.a"]);
  });

  it("空指令與不存在的可執行檔不會被執行就丟掉", async () => {
    const d = deps({ hasExecutable: (bin) => bin !== "nope" });
    const out = await validateProposal({ install: "true", test: "nope test", checks: [{ name: "x", cmd: "echo hi" }] }, d);
    expect(d.ran).toEqual([]);
    expect(out.install).toBeUndefined();
    expect(out.test).toBeUndefined();
    expect(out.checks).toEqual([]);
    expect(out.dropped.map((x) => x.field)).toEqual(["install", "test", "checks.x"]);
  });

  it("install 沒通過仍會嘗試 test（有些專案不需要安裝）", async () => {
    const d = deps({ fail: ["make deps"] });
    const out = await validateProposal({ install: "make deps", test: "make test" }, d);
    expect(out.install).toBeUndefined();
    expect(out.test).toBe("make test");
    expect(d.ran).toEqual(["make deps", "make test"]);
  });

  it("testPattern：無法編譯、或專案有測試檔卻一個都沒命中時丟掉", async () => {
    const bad = await validateProposal({ testPattern: "([" }, deps());
    expect(bad.testPattern).toBeUndefined();
    expect(bad.dropped[0]?.field).toBe("testPattern");
    const miss = await validateProposal({ testPattern: "_spec\\.rb$" }, deps({ files: ["test/a_test.rb", "src/a.rb"] }));
    expect(miss.testPattern).toBeUndefined();
    const hit = await validateProposal({ testPattern: "_test\\.rb$" }, deps({ files: ["test/a_test.rb"] }));
    expect(hit.testPattern).toBe("_test\\.rb$");
    const none = await validateProposal({ testPattern: "_spec\\.rb$" }, deps({ files: ["src/a.rb"] }));
    expect(none.testPattern).toBe("_spec\\.rb$");
  });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx vitest run src/generateDetected.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**（`src/generateDetected.ts`）

```ts
import type { DetectedFile, DetectionProposal } from "./schemas.js";

export interface ValidateDeps {
  /** 在臨時 worktree 內跑指令；逾時要回傳 ok: false */
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  /** 臨時 worktree 內追蹤檔的相對路徑 */
  files: string[];
  /** 指令的第一個可執行檔是否存在 */
  hasExecutable(bin: string): boolean;
}

export type Validated = Pick<DetectedFile, "install" | "test" | "checks" | "testPattern" | "dropped">;

/** 空指令與永遠會成功的指令：拿來當檢查等於沒有檢查 */
export function isTrivialCommand(cmd: string): boolean {
  return /^\s*(?:|true|:|exit\s+0|echo\b.*)\s*$/.test(cmd);
}

/** 指令第一個可執行檔，略過 VAR=值 的環境變數前綴 */
export function firstExecutable(cmd: string): string | undefined {
  return cmd.trim().split(/\s+/).find((token) => token !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
}

type Verdict = { ok: true } | { ok: false; reason: string };

async function tryCommand(cmd: string, deps: ValidateDeps): Promise<Verdict> {
  if (isTrivialCommand(cmd)) return { ok: false, reason: `指令沒有實際檢查：${cmd.trim() || "（空）"}` };
  const bin = firstExecutable(cmd);
  if (!bin || !deps.hasExecutable(bin)) return { ok: false, reason: `找不到可執行檔：${bin ?? cmd}` };
  const result = await deps.run(cmd);
  return result.ok ? { ok: true } : { ok: false, reason: `在基底上沒有通過：${cmd}` };
}

/**
 * 逐欄位驗證 agent 的提案；原則是「基底 commit 上必須是綠的」，否則 verify 會永遠失敗。
 * 不通過的欄位丟掉並記下原因，不影響其他欄位。順序：install → test → checks，因為 test 與 checks 可能需要先安裝。
 */
export async function validateProposal(p: DetectionProposal, deps: ValidateDeps): Promise<Validated> {
  const dropped: Validated["dropped"] = [];
  const out: Validated = { checks: [], dropped };
  if (p.install !== undefined) {
    const v = await tryCommand(p.install, deps);
    if (v.ok) out.install = p.install;
    else dropped.push({ field: "install", reason: v.reason });
  }
  if (p.test !== undefined) {
    const v = await tryCommand(p.test, deps);
    if (v.ok) out.test = p.test;
    else dropped.push({ field: "test", reason: v.reason });
  }
  for (const check of p.checks) {
    const v = await tryCommand(check.cmd, deps);
    if (v.ok) out.checks.push(check);
    else dropped.push({ field: `checks.${check.name}`, reason: v.reason });
  }
  if (p.testPattern !== undefined) {
    try {
      const re = new RegExp(p.testPattern);
      const testish = deps.files.filter((f) => /test|spec/i.test(f));
      if (testish.length > 0 && !testish.some((f) => re.test(f))) {
        dropped.push({ field: "testPattern", reason: `專案已有測試檔，但沒有任何一個符合：${p.testPattern}` });
      } else {
        out.testPattern = p.testPattern;
      }
    } catch {
      dropped.push({ field: "testPattern", reason: `不是合法的正規表示式：${p.testPattern}` });
    }
  }
  return out;
}
```

- [ ] **Step 4: 執行確認通過**

Run: `npx vitest run src/generateDetected.test.ts && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/generateDetected.ts src/generateDetected.test.ts
git commit -m "新增動態偵測提案的逐欄位驗證"
```

---

### Task 8：agent 呼叫、run 啟動整合與文件

**Files:**
- Create: `prompts/detect.md`
- Modify: `src/engine.ts`（新增並匯出 `detectWithAgent`）、`src/cli.ts`（`run` 指令）、`README.md`、`docs/workflow.md`
- Test: `src/detectAgent.test.ts`、`src/prompts.test.ts`（不需改，會自動涵蓋新 prompt）

**Interfaces:**
- Consumes: `validateProposal`／`ValidateDeps`（Task 7）、`readDetected`／`writeDetected`／`detectFingerprint`／`effectiveDefaults`（Task 6）、`withTempWorktree`、`execShell`、`specAgent`、`agentStep`
- Produces: `export async function detectWithAgent(run: FlowRun): Promise<void>`（run 建立後、安裝前呼叫；只在內建偵測為未知類型時動作；任何失敗都只印警告，不讓 run 失敗）

- [ ] **Step 1: 寫 prompt**（`prompts/detect.md`）

```markdown
<role>
你是專案環境分析師，負責判斷這個專案該怎麼安裝相依套件、跑測試與跑檢查。你只讀專案，不修改任何專案檔案。
</role>

<context>
目前的工作目錄就是專案（agentflowctl 為這次任務建立的專用 git worktree）。agentflowctl 無法辨識這個專案的類型（沒有 package.json、go.mod、Cargo.toml、pyproject.toml 等），需要你從專案本身找出答案。
</context>

<steps>
1. 閱讀專案根目錄與常見的建置、測試、CI 設定：Makefile、justfile、CMakeLists.txt、pom.xml、build.gradle*、*.sln／*.csproj、Gemfile、composer.json、mix.exs、.github/workflows/*.yml、README。
2. 找出：安裝相依套件的指令、跑測試的指令、其他值得在每次驗證時跑的檢查（例如建置、lint、型別檢查），以及測試檔的檔名規則。
3. 把結果寫入 .flow/detect-proposal.json。
</steps>

<constraints>
- 只寫入 .flow/detect-proposal.json，不要修改其他檔案。
- 指令必須能在專案根目錄直接執行，並且在目前未修改的程式碼上會成功（結束碼 0）。程式會逐一驗證，不通過的會被丟掉。
- 不確定的欄位就省略，不要猜。專案沒有測試時省略 test 與 testPattern。
- 不要提出永遠成功的指令（true、echo 等）。
- testPattern 是 JavaScript 正規表示式字串，比對對象是以 / 分隔的相對路徑。
- 只有 lint、型別檢查這類不必每個任務都跑的檢查才標 finalOnly: true。
</constraints>

<output_format>
.flow/detect-proposal.json：

```json
{
  "install": "安裝相依套件的指令（省略代表不需要）",
  "test": "跑測試的指令",
  "checks": [{ "name": "build", "cmd": "make build" }, { "name": "lint", "cmd": "make lint", "finalOnly": true }],
  "testPattern": "_spec\\.rb$"
}
```
</output_format>

<reply_format>
回覆最後附上 <result> 區塊，內容為一句話說明你的判斷依據。
<result>
<summary>判斷依據</summary>
</result>
</reply_format>
```

- [ ] **Step 2: 執行 prompt 渲染測試**

Run: `npx vitest run src/prompts.test.ts`
Expected: PASS（新 prompt 沒有變數，自動涵蓋）。若該測試要求每個 prompt 含特定區塊（例如 `<handoff>`），照失敗訊息補齊後再執行。

- [ ] **Step 3: 寫失敗測試**（`src/detectAgent.test.ts`，仿 `engine.test.ts` 的 command adapter 做法）

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "agentflowctl-detect-agent-"));
execFileSync("git", ["init", "-q", "-b", "main", root]);
writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
execFileSync("git", ["-C", root, "add", "Makefile"]);
execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
process.chdir(root);

// 假 agent：把 proposal 寫進 .flow/detect-proposal.json（內容由 PROPOSAL 檔決定）
const agentScript = join(root, "fake-agent.mjs");
writeFileSync(agentScript, `import { copyFileSync, existsSync } from "node:fs";
if (existsSync("../../../proposal.json")) copyFileSync("../../../proposal.json", ".flow/detect-proposal.json");
`);
writeFileSync(join(root, "flow.config.json"), JSON.stringify({
  agents: { a: { adapter: "command", command: ["node", agentScript] } }, cycle: ["a"],
}));

const { addWorktree } = await import("./git.js");
const { detectWithAgent } = await import("./engine.js");
const { readDetected } = await import("./detectedFile.js");
const { flowDir, worktreeDir } = await import("./paths.js");
const { saveRun } = await import("./store.js");

async function newRun(id: string) {
  await addWorktree(root, worktreeDir(id), "main", `flow/${id}`);
  mkdirSync(flowDir(id), { recursive: true });
  const now = new Date().toISOString();
  return saveRun({
    id, baseBranch: "main", branch: `flow/${id}`, requirement: "x", stage: "spec" as const,
    autopilot: true, maxAgentRuns: 10, cycle: ["a"], attempts: {}, taskIndex: 0, taskPhase: "tests" as const,
    createdAt: now, updatedAt: now,
  });
}

describe("detectWithAgent", () => {
  it("未知類型：提案經驗證後寫入 detected.json，壞的欄位被丟掉並記錄原因", async () => {
    writeFileSync(join(root, "proposal.json"), JSON.stringify({
      install: "true", test: "sh -c 'exit 0'", checks: [{ name: "bad", cmd: "sh -c 'exit 1'" }],
    }));
    const run = await newRun("f-detect-1");
    await detectWithAgent(run);
    const saved = readDetected(root);
    expect(saved?.test).toBe("sh -c 'exit 0'");
    expect(saved?.install).toBeUndefined();
    expect(saved?.checks).toEqual([]);
    expect(saved?.dropped.map((d) => d.field).sort()).toEqual(["checks.bad", "install"]);
  }, 30_000);

  it("指紋沒變時不再呼叫 agent；格式不合的提案記為全部丟棄", async () => {
    const run = await newRun("f-detect-2");
    const before = readDetected(root);
    await detectWithAgent(run);
    expect(readDetected(root)).toEqual(before);
    expect(existsSync(join(flowDir("f-detect-2"), "detect-proposal.json"))).toBe(false);
  }, 30_000);
});
```

（第二個測試驗證指紋命中時不會重跑 agent：沒有新的 `detect-proposal.json`。`tmp` 檔路徑 `../../../proposal.json` 是從 worktree `<root>/.agentflowctl/worktrees/<id>` 回到 `<root>`；若 agent 的 cwd 不同，改用絕對路徑寫進腳本。）

- [ ] **Step 4: 執行確認失敗**

Run: `npx vitest run src/detectAgent.test.ts`
Expected: FAIL（`detectWithAgent` 未匯出）

- [ ] **Step 5: 實作 `detectWithAgent`**（`src/engine.ts`，放在 `specStage` 之前）

新增 import：
```ts
import { detectFingerprint, readDetected, writeDetected } from "./detectedFile.js";
import { validateProposal } from "./generateDetected.js";
import { execShell } from "./proc.js";
```
（`./proc.js` 已 import `exec`，改為 `import { exec, execShell } from "./proc.js";`；`DetectionProposal` 加進 `./schemas.js` 的 import；`tail` 等沿用現有 import。）

```ts
/** 每個驗證用的指令最多跑 5 分鐘 */
const DETECT_COMMAND_TIMEOUT_MS = 5 * 60_000;

/**
 * 認不出專案類型時（沒有 package.json、go.mod、Cargo.toml、pyproject.toml 等），請一位 agent 讀專案提出
 * install／test／checks／testPattern，再由程式在基底 commit 的臨時 worktree 逐欄位驗證，通過的存進 detected.json。
 * 這只是選配的偵測：額度不足、agent 失敗、格式不合都只印警告，不讓 run 失敗；
 * 指紋沒變就不重做，全部無效也會記錄（避免每個 run 重複花用量）。
 */
export async function detectWithAgent(run: FlowRun): Promise<void> {
  const root = projectRoot();
  if (detectProjectDefaults(root).ecosystem !== "unknown") return;
  const fingerprint = detectFingerprint(root);
  if (readDetected(root)?.fingerprint === fingerprint) return;
  const agent = specAgent(run.cycle, run.id);
  info(run, `🔎 專案類型未知，請 ${agent} 分析怎麼安裝、測試與檢查`);
  let outcome: StepOutcome;
  try {
    outcome = await agentStep(run, agent, "detect", renderPrompt("detect", {}), { kind: "write" });
  } catch (error) {
    if (error instanceof QuotaPause || error instanceof AgentBudgetError) {
      info(run, `⚠️  ${error.message}；略過動態偵測`);
      return;
    }
    throw error;
  }
  await discardChanges(worktreeDir(run.id)); // 只允許寫 .flow/
  let proposal: DetectionProposal = { checks: [] };
  const dropped: { field: string; reason: string }[] = [];
  if (!outcome.r.ok) {
    dropped.push({ field: "proposal", reason: `Agent 執行失敗：${outcome.r.summary}` });
  } else {
    const read = readJsonFile(flowFile(run, "detect-proposal.json"), DetectionProposal);
    if (read.ok) proposal = read.data;
    else dropped.push({ field: "proposal", reason: read.error });
  }
  const validated = await withTempWorktree(run.id, "detect", async (ws) => {
    const files = (await git(ws.dir, "ls-files")).split("\n").filter(Boolean);
    return validateProposal(proposal, {
      files,
      hasExecutable: (bin) => {
        try {
          execFileSync("sh", ["-c", 'command -v "$1"', "sh", bin], { cwd: ws.dir, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      },
      run: async (cmd) => {
        const r = await execShell(cmd, { cwd: ws.dir, timeoutMs: DETECT_COMMAND_TIMEOUT_MS });
        return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
      },
    });
  });
  writeDetected(root, { ...validated, fingerprint, generatedAt: new Date().toISOString(), dropped: [...dropped, ...validated.dropped] });
  const kept = [validated.install && `install：${validated.install}`, validated.test && `test：${validated.test}`,
    ...validated.checks.map((c) => `checks.${c.name}：${c.cmd}`), validated.testPattern && `testPattern：${validated.testPattern}`].filter(Boolean);
  info(run, kept.length ? `✅ 動態偵測保留：${kept.join("；")}` : "ℹ️  動態偵測沒有可用的結果，略過安裝、檢查與紅綠燈");
  for (const d of [...dropped, ...validated.dropped]) info(run, `   ✗ ${d.field}：${d.reason}（可在 flow.config.json 手動設定）`);
}
```
需要補 `import { execFileSync } from "node:child_process";`（engine.ts 目前沒有）。

- [ ] **Step 6: `cli.ts` 的 `run` 整合**

在 `saveRun({...})` 之後、`describeDetected` 之前加：
```ts
    await detectWithAgent(run);
```
並把 `import { advance, iterateRun, loadRepoConfig, replanRun } from "./engine.js";` 加上 `detectWithAgent`。因為動態結果會改變設定，之後安裝要用重新讀取的設定，把：
```ts
    const install = await runCommand({ ... }, cfg.install);
```
的 `cfg.install` 改為 `loadRepoConfig().install`。

- [ ] **Step 7: 執行確認通過**

Run: `npx vitest run src/detectAgent.test.ts src/detectedFile.test.ts src/generateDetected.test.ts src/prompts.test.ts && pnpm run typecheck`
Expected: PASS。若 `detectAgent.test.ts` 因 agent cwd／相對路徑失敗，調整測試腳本的路徑，不改 `detectWithAgent` 的行為。

- [ ] **Step 8: 文件**

`README.md`（偵測那段尾巴）補一句：`認不出類型的專案，run 開始時會請一位 agent 分析安裝、測試與檢查指令，經程式在基底上逐項驗證後存進 .agentflowctl/detected.json（不進版控）；不通過的項目會丟掉並印出原因，沒有可用的測試指令就不走紅綠燈。`
`docs/workflow.md` 在「專案指令偵測」補一節「動態偵測」：觸發條件、指紋、驗證規則表（照 spec）、`detected.json` 位置與如何固定到 `flow.config.json`、額度不足時略過。

- [ ] **Step 9: 全套驗證與 Commit**

Run: `pnpm run typecheck && pnpm test 2>&1 | tail -8`
Expected: 全過

```bash
git add prompts/detect.md src/engine.ts src/cli.ts src/detectAgent.test.ts README.md docs
git commit -m "未知類型專案由 agent 動態偵測並經程式驗證"
```

---

### Task 9：收尾與 PR

- [ ] **Step 1: 最終驗證**

Run: `pnpm run typecheck && pnpm test 2>&1 | tail -8 && pnpm run build`
Expected: 全過

- [ ] **Step 2: 以 devlog-tracker 實測偵測結果**

Run: `npx tsx -e 'import("./src/detectedFile.ts").then(m=>{const d=m.effectiveDefaults("/Users/gogogohuang/Documents/p/project/devlog-tracker");console.log(d.ecosystem,JSON.stringify(d.checks))})'`
Expected: `node [{"name":"test","cmd":"npm run test"}]`（它有 `package.json`，沿用 Node 偵測；不再出現 `npx vite build`）。

- [ ] **Step 3: 開 PR**

分支 `feat/multi-ecosystem-detect` 含 spec、計畫與實作。先確認 PR #71 是否已合併；沒合併就把 `main` 合進來或在 PR 描述註明相依。

```bash
git push -u origin feat/multi-ecosystem-detect
gh pr create --base main --title "多語言專案偵測：Node／Python／Go／Rust 與動態偵測" --body "<依 spec 摘要；結尾加 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
```

---

## Self-Review（計畫對照 spec）

- **優先順序**（手寫 > detected.json > 內建 > 略過）：Task 6 `effectiveDefaults`＋`withProjectDefaults`（手寫 `...raw` 最後展開）；未知時才疊 detected.json。✔
- **測試框架判定表**：Node 沿用；Python（Task 3）、Go／Rust（Task 2）、動態（Task 6 `testFramework: g.test !== undefined`）。✔
- **內建偵測表**：Task 2、3；testPattern 併入設定 Task 4。✔
- **動態產生**：時機與條件（Task 8 `detectWithAgent`，指紋 Task 6）、額度不足略過（Task 8 catch `QuotaPause`／`AgentBudgetError`）、計入 `maxAgentRuns`（經 `agentStep`）。✔
- **驗證規則表**：Task 7 逐項對應（install 通過、test 通過否則視為無測試框架、check 逐項、testPattern）。逾時 5 分鐘在 Task 8 的 `execShell` `timeoutMs`。✔
- **全無效也記錄**：`writeDetected` 一律寫入。✔
- **「未知」定義**：Task 1 分派器（含空資料夾、lockfile 視為 Node）。✔
- **影響範圍**：`dump.ts` 不變（專案層級）；prompts 檢查在 Task 4 Step 4。✔
- 型別一致性：`ProjectDefaults.ecosystem`／`testPattern`（Task 1）→ Task 4、6 使用；`DetectionProposal`／`DetectedFile`（Task 6）→ Task 7、8 使用；`validateProposal` 回傳 `Validated`（Task 7）→ Task 8 展開進 `writeDetected`。✔
- 已知風險：Task 1 Step 5 需要逐一修既有測試（空資料夾不再有 Node 預設）；Task 8 的 `detectAgent.test.ts` 依賴 agent cwd 與相對路徑，實作者可能需要調整測試腳本。
