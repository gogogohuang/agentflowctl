# EcosystemProfile 實作計畫

> **給 agentic worker：** 必須用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐項執行。步驟用 checkbox（`- [ ]`）追蹤。

**目標：** 引擎只依「偵測到的專案資料」運作，不再假設目標專案是 Node + Vite + TypeScript + Vitest；Node 專案行為不變，Python／Go／Rust 與未辨識專案守門不失效。

**架構：** 新增 `src/profile.ts`，以純資料（字串形式的正規表示式、陣列）描述每個生態系統的差異；`ProjectDefaults` 帶一個 `profile`；引擎各處（`testGuard`、`tempWorktree`、`util`、`findFiles`、prompt）改成接收 profile。`detected.json`（generated）只能補 profile 的缺欄位並由程式驗證。

**技術：** TypeScript（ESM、Node >= 22）、zod、vitest。

**Spec：** `docs/superpowers/specs/2026-10-04-ecosystem-profile-design.md`

## 全域限制

- 程式碼、註解、prompt、commit 訊息、使用者看到的輸出一律繁體中文（AGENTS.md）。
- 每個使用者看得到的行為改動，要在同一個 commit 更新 `README.md`（必要時 `docs/configuration.md`、`examples/flow.config.json`）。
- 新增 `FlowRun` 欄位要選填；本計畫不新增 `FlowRun` 欄位。
- 關卡判斷以程式能檢查的事實為準，不依賴 agent 回覆內容。
- 每個 commit 都要通過 `pnpm run typecheck` 與 `pnpm test`。
- commit 訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 在分支 `feat/ecosystem-profile` 上工作（spec 已在該分支，`main` 仍是 `21295d4`）。不推送、不開 PR，除非使用者要求。

## 與 spec 的三處差異（Task 8 一併修改 spec）

1. 多一個「profile 基礎」commit（Task 1–2），所以是 5 個 commit：基礎、A、B、C、D。
2. `detectNode` 維持現狀：`typecheck`、`lint` 只在專案有對應 script 時加入（不因 `tsconfig.json`／eslint 設定自動補指令，避免基底上本來就會失敗的檢查）。`node:test` 專案靠 `test` script 辨識，不另外用依賴辨識。測試指令的依賴辨識只認 vitest、jest、mocha、ava、jasmine；其他框架（tap、uvu、playwright、cypress）沒有 `test` script 時視為沒有測試框架（因為無法決定指令）。
3. `DetectionProposal` 的 `failureBlock` 改為列舉 `failureFormat`（`tap`／`pytest`／`go`／`cargo`），agent 只能挑格式，不能提供任意區塊規則。`acceptanceChecks.ts` 的 `TOOL_NAMES` 已含 pytest、ruff、clippy 等，不需要改。

## 檔案結構

- 新增 `src/profile.ts`：`EcosystemProfile` 型別、五份 profile 常數（`NODE_PROFILE`、`PYTHON_PROFILE`、`GO_PROFILE`、`RUST_PROFILE`、`NEUTRAL_PROFILE`）、`anyOf`、`testSourceOf`、`isSourceFile`、`mergeProfile`。
- 新增 `src/profile.test.ts`。
- 修改 `src/detect.ts`（`ProjectDefaults.profile`、中性預設、`detectNode` 重寫、pip venv、`findFiles` 的 `skipDirs` 參數）。
- 修改 `src/schemas.ts`（`RepoConfig` 中性預設、`DetectionProposal` 新欄位）。
- 修改 `src/testGuard.ts`、`src/util.ts`、`src/tempWorktree.ts`、`src/engine.ts`、`src/cli.ts`、`src/detectedFile.ts`、`src/generateDetected.ts`。
- 修改 `prompts/{spec,fast-plan,plan,plan-fix,implement-tests,implement-code,detect}.md`。
- 修改 `README.md`、`docs/configuration.md`、`examples/flow.config.json`。

---

### Task 1：profile 資料模組

**Files:**
- Create: `src/profile.ts`
- Test: `src/profile.test.ts`

**Interfaces:**
- Produces（後續 task 依賴的確切名稱）：
  - `type FailureFormat = "tap" | "pytest" | "go" | "cargo"`
  - `interface PromptHints { manifestFiles: string; exampleSource: string; exampleTest: string; dependencyNote: string }`
  - `interface EcosystemProfile`（欄位見下方程式碼）
  - 常數 `NODE_PROFILE`、`PYTHON_PROFILE`、`GO_PROFILE`、`RUST_PROFILE`、`NEUTRAL_PROFILE`
  - `anyOf(patterns: readonly string[]): RegExp | undefined`
  - `testSourceOf(profile: EcosystemProfile, file: string): string | undefined`
  - `isSourceFile(profile: EcosystemProfile, file: string): boolean`

- [ ] **Step 1：寫失敗的測試** `src/profile.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { anyOf, GO_PROFILE, isSourceFile, NEUTRAL_PROFILE, NODE_PROFILE, PYTHON_PROFILE, RUST_PROFILE, testSourceOf, type EcosystemProfile } from "./profile.js";

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
```

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/profile.test.ts`
Expected: FAIL（找不到 `./profile.js`）

- [ ] **Step 3：實作** `src/profile.ts`

```ts
/**
 * 各生態系統的差異資料：引擎的守門、依賴目錄、失敗輸出格式與 prompt 範例都從這裡取，不再寫死 Node 的慣例。
 * 全部是純資料（正規表示式用字串），可以直接存進 detected.json、不必序列化函式。
 * 偵測不到的欄位用空值：對應的守門停用，不退回 JS 的預設。
 */

/** 失敗輸出的區塊格式：failureTail 用來在輸出太長時保留被擠出尾端的失敗測試 */
export type FailureFormat = "tap" | "pytest" | "go" | "cargo";

/** 代入 prompt 的範例字串；沒有對應生態系統時用中性字樣 */
export interface PromptHints {
  /** 讀專案時該看的檔案與目錄 */
  manifestFiles: string;
  /** 範例被測檔路徑 */
  exampleSource: string;
  /** 範例測試檔路徑（對應 exampleSource） */
  exampleTest: string;
  /** 提醒測試作者「只用已安裝版本支援的 API」時的補充說明 */
  dependencyNote: string;
}

export interface EcosystemProfile {
  /** 車道與審查者的臨時 worktree 共用（symlink）的依賴目錄，相對於專案根目錄 */
  depDirs: string[];
  /** findFiles 略過的目錄名稱 */
  skipDirs: string[];
  /** 程式碼檔案的副檔名（含點）；抑制註解只在這些檔案才有意義 */
  sourceExts: string[];
  /** 新增「跳過測試」的語法 */
  skipPatterns: string[];
  /** 新增「抑制型別或 lint」的語法 */
  suppressPatterns: string[];
  /** 斷言行；沒有就不偵測斷言減少 */
  assertPattern?: string;
  /** 測試檔對應被測檔：re 比對測試檔路徑，to 是帶 $1… 的被測檔路徑樣板 */
  testSourcePairs: { re: string; to: string }[];
  /** 從測試輸出的一行裡找出測試檔路徑（會以 g 旗標使用） */
  testFilePattern?: string;
  /** 測試輸出裡「這一行代表有失敗」的規則 */
  failureLine?: string;
  failureFormat?: FailureFormat;
  /** 紅燈階段能不能用 require 檢查測試呼叫的套件匯出（只有 Node） */
  packageProbe: boolean;
  hints: PromptHints;
}

export const NEUTRAL_HINTS: PromptHints = {
  manifestFiles: "專案的依賴檔、設定檔與原始碼目錄",
  exampleSource: "<目錄>/<檔名>",
  exampleTest: "<目錄>/<測試檔名>",
  dependencyNote: "（要看依賴檔裡的實際版本）",
};

/** 什麼都不知道：所有依賴語言的守門停用 */
export const NEUTRAL_PROFILE: EcosystemProfile = {
  depDirs: [],
  skipDirs: [".git", ".agentflowctl", ".flow", ".worktree", ".worktrees", "dist", "build"],
  sourceExts: [],
  skipPatterns: [],
  suppressPatterns: [],
  testSourcePairs: [],
  packageProbe: false,
  hints: NEUTRAL_HINTS,
};

export const NODE_PROFILE: EcosystemProfile = {
  ...NEUTRAL_PROFILE,
  depDirs: ["node_modules"],
  skipDirs: [...NEUTRAL_PROFILE.skipDirs, "node_modules"],
  sourceExts: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"],
  skipPatterns: [String.raw`\b(?:it|test|describe|context)\.(?:skip|todo|only)\b|\b(?:xit|xtest|xdescribe)\s*\(|\.only\s*\(`],
  suppressPatterns: ["@ts-ignore|@ts-nocheck|eslint-disable"],
  assertPattern: String.raw`\b(?:expect|assert\w*)\s*[(.]`,
  testSourcePairs: [{ re: String.raw`^(.*)\.(?:test|spec)(\.[cm]?[jt]sx?)$`, to: "$1$2" }],
  testFilePattern: String.raw`[\w@.\/-]+\.(?:test|spec)\.[cm]?[jt]sx?`,
  failureLine: String.raw`\bFAIL\b|[❯×✗✕]`,
  failureFormat: "tap",
  packageProbe: true,
  hints: {
    manifestFiles: "package.json、src/",
    exampleSource: "src/form.ts",
    exampleTest: "src/form.test.ts",
    dependencyNote: "（例如 `renderHook` 在較舊的 @testing-library/react 不存在，要看 package.json 的實際版本）",
  },
};

export const PYTHON_PROFILE: EcosystemProfile = {
  ...NEUTRAL_PROFILE,
  depDirs: [".venv"],
  skipDirs: [...NEUTRAL_PROFILE.skipDirs, "venv", ".venv", "__pycache__", ".pytest_cache"],
  sourceExts: [".py"],
  skipPatterns: [String.raw`@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.(?:skip|xfail)\s*\(|\bself\.skipTest\s*\(`],
  suppressPatterns: [String.raw`#\s*(?:noqa|type:\s*ignore|pylint:\s*disable)`],
  assertPattern: String.raw`^\s*assert\b|\bself\.assert\w*\s*\(|\bpytest\.raises\s*\(`,
  testSourcePairs: [
    { re: String.raw`^(.*/)?test_([^/]+)\.py$`, to: "$1$2.py" },
    { re: String.raw`^(.*)_test\.py$`, to: "$1.py" },
  ],
  testFilePattern: String.raw`[\w@.\/-]+\.py`,
  failureLine: String.raw`^(?:FAILED|ERROR)\b|\bFAILED\b`,
  failureFormat: "pytest",
  hints: {
    manifestFiles: "pyproject.toml／requirements.txt、src/",
    exampleSource: "src/form.py",
    exampleTest: "tests/test_form.py",
    dependencyNote: "（要看依賴檔裡鎖定的實際版本，例如 pytest 外掛的 API 會隨版本不同）",
  },
};

export const GO_PROFILE: EcosystemProfile = {
  ...NEUTRAL_PROFILE,
  skipDirs: [...NEUTRAL_PROFILE.skipDirs, "vendor"],
  sourceExts: [".go"],
  skipPatterns: [String.raw`\bt\.Skip(?:f|Now)?\s*\(`],
  suppressPatterns: [String.raw`//\s*nolint\b`],
  assertPattern: String.raw`\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\(`,
  testSourcePairs: [{ re: String.raw`^(.*)_test\.go$`, to: "$1.go" }],
  testFilePattern: String.raw`[\w.\/-]+_test\.go`,
  failureLine: String.raw`_test\.go:\d+`,
  failureFormat: "go",
  hints: {
    manifestFiles: "go.mod、各套件目錄",
    exampleSource: "internal/form/form.go",
    exampleTest: "internal/form/form_test.go",
    dependencyNote: "（要看 go.mod 裡的實際版本）",
  },
};

export const RUST_PROFILE: EcosystemProfile = {
  ...NEUTRAL_PROFILE,
  depDirs: ["target"],
  skipDirs: [...NEUTRAL_PROFILE.skipDirs, "target"],
  sourceExts: [".rs"],
  skipPatterns: [String.raw`#\[ignore\b`],
  suppressPatterns: [String.raw`#!?\[allow\(`],
  assertPattern: String.raw`\b(?:debug_)?assert(?:_eq|_ne)?!\s*\(`,
  testSourcePairs: [{ re: String.raw`^(.*)_test\.rs$`, to: "$1.rs" }],
  testFilePattern: String.raw`[\w.\/-]+\.rs`,
  failureLine: String.raw`panicked at`,
  failureFormat: "cargo",
  hints: {
    manifestFiles: "Cargo.toml、src/",
    exampleSource: "src/form.rs",
    exampleTest: "tests/form.rs",
    dependencyNote: "（要看 Cargo.toml 與 Cargo.lock 裡的實際版本）",
  },
};

/** 把多個規則字串合成一個 RegExp；沒有規則就是 undefined（該守門停用） */
export function anyOf(patterns: readonly string[]): RegExp | undefined {
  return patterns.length ? new RegExp(patterns.map((p) => `(?:${p})`).join("|")) : undefined;
}

/** 測試檔對應的被測檔；不符合任何命名規則時回傳 undefined */
export function testSourceOf(profile: EcosystemProfile, file: string): string | undefined {
  for (const { re, to } of profile.testSourcePairs) {
    const rx = new RegExp(re);
    if (rx.test(file)) return file.replace(rx, to);
  }
  return undefined;
}

/** 抑制註解只在程式碼檔案才有意義；文件、設定與鎖定檔提到它們不算 */
export function isSourceFile(profile: EcosystemProfile, file: string): boolean {
  return profile.sourceExts.some((ext) => file.endsWith(ext));
}
```

- [ ] **Step 4：確認通過**

Run: `npx vitest run src/profile.test.ts`
Expected: PASS（若 `assertPattern` 的 python 案例失敗，檢查 `^\s*assert\b` 是否被多行旗標影響：測試用的是單行字串，不需要旗標）

- [ ] **Step 5：暫不 commit**（與 Task 2 一起成為「profile 基礎」commit）

---

### Task 2：`ProjectDefaults.profile` 與 `projectProfile()`

**Files:**
- Modify: `src/detect.ts`（`ProjectDefaults`、各 `detectXxx`、`findFiles`、`withProjectDefaults` 不變）
- Modify: `src/engine.ts`（新增 `projectProfile()`）
- Test: `src/detect.test.ts`（新增案例）

**Interfaces:**
- Consumes：Task 1 的 `EcosystemProfile`、各 `*_PROFILE`。
- Produces：
  - `ProjectDefaults.profile: EcosystemProfile`（必填）
  - `findFiles(root: string, re: RegExp, skipDirs: readonly string[], max = 5000): string[]`
  - `engine.ts` 的 `projectProfile(): EcosystemProfile`（讀 `effectiveDefaults(projectRoot()).profile`）

- [ ] **Step 1：寫失敗的測試**（加在 `src/detect.test.ts` 的 `describe` 內；`project()` 是檔案內既有的建立暫存專案的 helper）

```ts
it("profile：各生態系統帶對應的資料", () => {
  expect(detectProjectDefaults(project({ "package.json": "{}" })).profile.depDirs).toEqual(["node_modules"]);
  expect(detectProjectDefaults(project({ "go.mod": "module x\n" })).profile.failureFormat).toBe("go");
  expect(detectProjectDefaults(project({ "Cargo.toml": "[package]\n" })).profile.depDirs).toEqual(["target"]);
  expect(detectProjectDefaults(project({ "requirements.txt": "pytest\n" })).profile.failureFormat).toBe("pytest");
  expect(detectProjectDefaults(project({ "README.md": "x" })).profile.sourceExts).toEqual([]);
});
```

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/detect.test.ts -t "profile：各生態系統"`
Expected: FAIL（`profile` 為 undefined）

- [ ] **Step 3：實作**
  - `detect.ts` 頂端加 `import { GO_PROFILE, NEUTRAL_PROFILE, NODE_PROFILE, PYTHON_PROFILE, RUST_PROFILE, type EcosystemProfile } from "./profile.js";`
  - `ProjectDefaults` 加欄位 `profile: EcosystemProfile;`，註解「這個生態系統的守門、依賴目錄與 prompt 資料」。
  - `detectNode` 的回傳加 `profile: NODE_PROFILE`；`detectGo`／`detectRust`／`detectPython`／`detectUnknown` 分別加 `profile: GO_PROFILE`／`RUST_PROFILE`／`PYTHON_PROFILE`／`NEUTRAL_PROFILE`。
  - 移除 `SKIP_DIRS` 常數；`findFiles` 簽名改為 `findFiles(root, re, skipDirs, max = 5000)`，內部 `SKIP_DIRS.has(entry.name)` 改成 `skipDirs.includes(entry.name)`。
  - 三個呼叫處改傳 profile 的 `skipDirs`：`findFiles(root, new RegExp(GO_TEST_PATTERN), GO_PROFILE.skipDirs)`、`RUST_PROFILE.skipDirs`、`PYTHON_PROFILE.skipDirs`。
  - `overlayGenerated`（`src/detectedFile.ts`）用 `...base` 展開，`profile` 自動沿用，不用改。
  - `src/engine.ts` 在 `hasTestFramework()` 旁新增：

```ts
/** 目前專案的生態系統資料（守門、依賴目錄、失敗輸出格式、prompt 範例） */
function projectProfile(): EcosystemProfile {
  return effectiveDefaults(projectRoot()).profile;
}
```
  並 `import type { EcosystemProfile } from "./profile.js";`。
  - 其他測試或程式若直接呼叫 `findFiles`（用 `grep -rn "findFiles" src` 找），補上第三個參數。

- [ ] **Step 4：全套驗證**

Run: `pnpm run typecheck && pnpm test`
Expected: 全部通過（行為沒有變）

- [ ] **Step 5：Commit（profile 基礎）**

```bash
git add src/profile.ts src/profile.test.ts src/detect.ts src/detect.test.ts src/engine.ts
git commit -m "新增 EcosystemProfile：以資料描述各生態系統的差異（行為不變）

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3：中性預設、Node 依實際依賴偵測、pip 用獨立 venv（commit A）

**Files:**
- Modify: `src/schemas.ts`（`RepoConfig` 預設）
- Modify: `src/detect.ts`（`detectNode`、`detectPython`、常數）
- Modify: `README.md`、`docs/configuration.md`
- Test: `src/detect.test.ts`、`src/schemas.test.ts`

**Interfaces:**
- Consumes：`NO_INSTALL`（既有，`"true"`）。
- Produces：`RepoConfig.parse({})` 回傳 `install: "true"`、`test: "true"`、`checks: []`、通用 `testPattern`；`NODE_TEST_PATTERN` 常數（detect.ts，值為舊的 schema 預設 `\\.(test|spec)\\.[cm]?[jt]sx?$`）。

- [ ] **Step 1：寫失敗的測試**

`src/schemas.test.ts` 新增：

```ts
it("RepoConfig 預設是中性的：不假設任何框架", () => {
  const d = RepoConfig.parse({});
  expect(d.install).toBe("true");
  expect(d.test).toBe("true");
  expect(d.checks).toEqual([]);
  const re = new RegExp(d.testPattern);
  for (const f of ["src/a.test.ts", "src/a.spec.js", "tests/x.py", "pkg/test_a.py", "pkg/a_test.go", "tests/form.rs"]) expect(re.test(f), f).toBe(true);
  expect(re.test("src/a.ts")).toBe(false);
});
```

`src/detect.test.ts` 新增：

```ts
it("node：沒有 test script 時依依賴挑測試指令，不再退回 vitest", () => {
  const jest = detectProjectDefaults(project({ "package.json": JSON.stringify({ devDependencies: { jest: "^29" } }) }));
  expect(jest.testFramework).toBe(true);
  expect(jest.test).toBe("npx jest");
  const vitest = detectProjectDefaults(project({ "package.json": JSON.stringify({ devDependencies: { vitest: "^2" } }) }));
  expect(vitest.test).toBe(`npx vitest run ${VITEST_WORKTREE_EXCLUDES}`);
  const none = detectProjectDefaults(project({ "package.json": "{}" }));
  expect(none.testFramework).toBe(false);
  expect(none.test).toBe("true");
  expect(none.checks).toEqual([]);
});

it("node：build 只在有 build script 或 Vite 專案時加入", () => {
  expect(detectProjectDefaults(project({ "package.json": "{}" })).checks.some((c) => c.name === "build")).toBe(false);
  const vite = detectProjectDefaults(project({ "package.json": JSON.stringify({ devDependencies: { vite: "^5" } }) }));
  expect(vite.checks.find((c) => c.name === "build")?.cmd).toBe("npx vite build");
});

it("python：只有 requirements.txt 時用獨立 venv", () => {
  const d = detectProjectDefaults(project({ "requirements.txt": "pytest>=8\n" }));
  expect(d.install).toBe("python3 -m venv .venv && .venv/bin/pip install -r requirements.txt");
  expect(d.test).toBe(".venv/bin/pytest");
  const unittest = detectProjectDefaults(project({ "requirements.txt": "requests\n", "tests/test_a.py": "import unittest\n" }));
  expect(unittest.test).toBe(".venv/bin/python3 -m unittest discover");
});
```
（`VITEST_WORKTREE_EXCLUDES` 從 `./schemas.js` 引入；若測試檔已引入就不用重複。）

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/detect.test.ts src/schemas.test.ts`
Expected: 新增的案例 FAIL；既有的舊預設案例也會 FAIL（下一步一併處理）

- [ ] **Step 3：實作 `schemas.ts`**

把 `RepoConfig` 的 `install`／`test`／`testPattern`／`checks` 預設改成：

```ts
  /** 沒有偵測結果時不安裝；偵測與手動設定的值一律優先（detect.ts） */
  install: z.string().default("true"),
  test: z.string().default("true"),
  /** 通用的測試檔命名：tests/、__tests__/、test_*、*_test.*、*.test.*、*.spec.*；偵測到生態系統時由偵測結果取代 */
  testPattern: z.string().default(String.raw`(^|/)(tests?|__tests__)/|(^|/)test_[^/]+$|[._-](test|spec)s?\.[^/]+$`),
  checks: z
    .array(z.object({ /* 欄位不變 */ }))
    .default([]),
```
並把檔案開頭註解「預設值對應 Vite + TypeScript + Vitest 專案」改成「預設值是中性的：沒有偵測結果時不安裝、不跑檢查」。`ESLINT_IGNORE_*`、`VITEST_WORKTREE_EXCLUDES` 留在 schemas.ts（detect.ts 在引用）。

- [ ] **Step 4：實作 `detect.ts`**
  - 新增常數並刪除 `INSTALL.npm: RepoConfig.parse({}).install`：

```ts
const NPM_INSTALL = "npm install --no-audit --no-fund";
const INSTALL: Record<PackageManager, string> = { npm: NPM_INSTALL, pnpm: "pnpm install", yarn: "yarn install", bun: "bun install" };

/** Node 專案的測試檔命名（舊的 RepoConfig 預設） */
const NODE_TEST_PATTERN = String.raw`\.(test|spec)\.[cm]?[jt]sx?$`;

/** 依賴裡有這些就知道怎麼跑測試；其他框架（tap、uvu、playwright…）沒有 test script 時無法決定指令 */
const TEST_RUNNERS: [dep: string, cmd: string][] = [["vitest", "vitest run"], ["jest", "jest"], ["mocha", "mocha"], ["ava", "ava"], ["jasmine", "jasmine"]];
```
  - 刪除 `FINAL_CHECKS`、`TEST_FRAMEWORKS`、`hasTestFramework`、`isNonViteProject`、`withExec`；新增：

```ts
/** Vite 專案：依賴有 vite、vite.config.*，或根目錄有 index.html */
function hasVite(root: string, pkg: PackageJson): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("vite" in deps || existsSync(join(root, "index.html"))) return true;
  return ["ts", "js", "mjs", "mts", "cjs", "cts"].some((ext) => existsSync(join(root, `vite.config.${ext}`)));
}
```
  - 以下列程式碼取代整個 `detectNode`：

```ts
function detectNode(root: string): ProjectDefaults {
  const pkg = readPackageJson(root);
  const { manager, source } = detectManager(root, pkg);
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const run = (script: string) => `${manager} run ${script}`;
  const exec = (cmd: string) => `${EXEC[manager]} ${cmd}`;
  const scriptFor = (name: string) => CHECK_SCRIPTS[name]?.find((s) => typeof scripts[s] === "string");
  const checks: Check[] = [];

  // lint 與型別檢查只在最後整支分支才跑，專案沒有對應 script 就略過，不自己補指令
  const typecheck = scriptFor("typecheck");
  if (typecheck) checks.push({ name: "typecheck", cmd: run(typecheck), finalOnly: true });
  const lint = scriptFor("lint");
  if (lint) {
    // lint script 若是 eslint（常見寫法 eslint .）會掃到 .flow/ 與本機 worktree，所以在指令列補上略過
    const eslint = /\beslint\b/.test(String(scripts[lint]));
    checks.push({ name: "lint", cmd: eslint ? withArgs(run(lint), ESLINT_IGNORE_ARGS, manager) : run(lint), finalOnly: true, changedOnly: true });
  }

  // 紅綠燈與 checks.test 要跑同一個框架：專案有 test script 就用它（例如 node:test 專案），否則看依賴裡的測試框架
  const testScript = scriptFor("test");
  const realScript = testScript !== undefined && !/no test specified/i.test(String(scripts[testScript]));
  const runner = TEST_RUNNERS.find(([dep]) => dep in deps);
  let test: string | undefined;
  if (realScript) {
    // 專案 script 已是 vitest 時只附加排除，不改寫 script 本身；其他測試指令維持原樣
    test = /\bvitest\b/.test(String(scripts[testScript])) ? withArgs(run(testScript), VITEST_WORKTREE_EXCLUDES, manager) : run(testScript);
  } else if (runner) {
    test = runner[0] === "vitest" ? `${exec(runner[1])} ${VITEST_WORKTREE_EXCLUDES}` : exec(runner[1]);
  }
  if (test) checks.push({ name: "test", cmd: test });

  const build = scriptFor("build");
  if (build) checks.push({ name: "build", cmd: run(build) });
  else if (hasVite(root, pkg)) checks.push({ name: "build", cmd: exec("vite build") });

  return {
    ecosystem: "node", manager, source, install: INSTALL[manager], test: test ?? NO_INSTALL, checks,
    testFramework: test !== undefined, testPattern: NODE_TEST_PATTERN, profile: NODE_PROFILE,
  };
}
```
  （`withArgs` 保留；`RepoConfig` 的 import 若不再使用就移除，只留 `ESLINT_IGNORE_ARGS`、`VITEST_WORKTREE_EXCLUDES`。）
  - `detectPython` 的 pip 兩條分支改用 venv：

```ts
      : has("requirements.txt")
        ? ["pip", "requirements.txt", "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt", ".venv/bin/"]
        : ["pip", "pyproject.toml／setup.py", "python3 -m venv .venv && .venv/bin/pip install -e .", ".venv/bin/"];
```
  並把 `const test = ...` 的 unittest 分支改為 `${run}${pytest ? "pytest" : run ? "python3 -m unittest discover" : "python3 -m unittest discover"}`——即不論有無 `run` 前綴都是 `python3 -m unittest discover`，前綴照舊接在前面（`.venv/bin/python3 -m unittest discover`），這行本來就是 `${run}${pytest ? "pytest" : "python3 -m unittest discover"}`，**不必改**。
  - `describeDetected` 的說明文字不用改。

- [ ] **Step 5：處理既有測試**

Run: `npx vitest run`
預期有失敗，逐一判斷，只允許下列三類被刻意改變的期望更新，其餘失敗代表實作有誤：
  1. 斷言 `RepoConfig.parse({})` 的舊預設（vitest、tsc、eslint、`npm install`）→ 改成中性預設。
  2. 斷言 Node 專案「沒有 vitest 依賴也沒有 script 卻得到 `npx vitest run`」→ 改成 `true`／沒有測試框架。
  3. 斷言 pip 專案的 `python3 -m pip install ...` 與無前綴的 `pytest` → 改成 venv 版本。
  凡是 `loadRepoConfig`／engine 測試靠舊預設跑流程的，在測試的 `flow.config.json` 明寫 `install`、`test`、`checks`，不要回頭改預設。

- [ ] **Step 6：更新文件**：`README.md` 偵測段落（第 121 行附近）改寫：「專案有 `test` script 時紅綠燈與 `checks.test` 都跑它，沒有時依依賴裡的 vitest／jest／mocha／ava／jasmine 決定；都沒有就沒有測試框架」；刪除「沒有才用預設的 vitest」與「非 Vite 專案沒有 `build` script 時不跑 build 檢查」，改成「`build` 檢查只在有 `build` script 或 Vite 專案時加入」；補「只有 `requirements.txt`／`pyproject.toml`（沒有 uv、poetry）的 Python 專案在 worktree 內建立 `.venv` 安裝與執行」。`docs/configuration.md` 若有預設值表格，改成中性預設。

- [ ] **Step 7：驗證並 Commit**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

```bash
git add -A src README.md docs/configuration.md
git commit -m "RepoConfig 改中性預設；Node 依實際依賴挑測試指令；pip 專案用獨立 venv

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4：依賴目錄 profile 化（commit B）

**Files:**
- Modify: `src/tempWorktree.ts`、`src/engine.ts`、`src/cli.ts`
- Test: `src/tempWorktree.test.ts`、`src/engine.test.ts`（或 `src/parallelEngine.test.ts`，沿用現有檔案裡建立車道的測試）
- Modify: `README.md`

**Interfaces:**
- Consumes：`projectProfile()`、`EcosystemProfile.depDirs`。
- Produces：
  - `createTempWorktree(runId: string, name: string, depDirs: readonly string[]): Promise<Workspace>`
  - `withTempWorktree<T>(runId: string, name: string, depDirs: readonly string[], fn: (ws: Workspace) => Promise<T>): Promise<T>`
  - engine 內 `linkDepDirs(from: string, to: string, depDirs: readonly string[]): void`

- [ ] **Step 1：寫失敗的測試**（`src/tempWorktree.test.ts`，沿用該檔既有的建立 run／worktree 的 helper）

```ts
it("依 depDirs 建立 symlink，不寫死 node_modules", async () => {
  // 在 run worktree 建立 .venv 與 node_modules 兩個目錄
  mkdirSync(join(worktreeDir(runId), ".venv"), { recursive: true });
  mkdirSync(join(worktreeDir(runId), "node_modules"), { recursive: true });
  const ws = await createTempWorktree(runId, "slot-1", [".venv"]);
  try {
    expect(lstatSync(join(ws.dir, ".venv")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ws.dir, "node_modules"))).toBe(false);
  } finally {
    await removeTempWorktree(runId, ws);
  }
});
```

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/tempWorktree.test.ts`
Expected: FAIL（簽名不符／仍連 `node_modules`）

- [ ] **Step 3：實作**
  - `tempWorktree.ts`：`createTempWorktree` 與 `withTempWorktree` 加 `depDirs` 參數；把 `const deps = join(worktreeDir(runId), "node_modules"); if (existsSync(deps)) symlinkSync(...)` 換成：

```ts
    for (const dir of depDirs) {
      const deps = join(worktreeDir(runId), dir);
      if (existsSync(deps)) symlinkSync(deps, join(ws.dir, dir), process.platform === "win32" ? "junction" : "dir");
    }
```
  註解與 JSDoc 裡的「node_modules」改成「依賴目錄（profile.depDirs）」。
  - `engine.ts`：
    - 兩個 `withTempWorktree(run.id, ...)` 呼叫（`detect` 與 `slot-N`）加第三個參數 `projectProfile().depDirs`。detect 那個專案是未知類型，傳 `[]` 也可（`NEUTRAL_PROFILE.depDirs` 本來就是 `[]`），統一用 `projectProfile().depDirs`。
    - 新增並使用共用 helper，取代車道建立處（`engine.ts` 約 1883–1893 行）的 `excludePaths(root, ["/node_modules"])` 與 symlink：

```ts
/** 把 run worktree 的依賴目錄 symlink 給車道；symlink 不是目錄，.gitignore 的 `dir/` 擋不住，commitAll 會把它加進去，所以另外 exclude */
async function linkDepDirs(root: string, from: string, to: string, depDirs: readonly string[]): Promise<void> {
  await excludePaths(root, depDirs.map((d) => `/${d}`));
  for (const dir of depDirs) {
    const deps = join(from, dir);
    if (existsSync(deps)) symlinkSync(deps, join(to, dir), process.platform === "win32" ? "junction" : "dir");
  }
}
```
      車道建立處改為 `await linkDepDirs(root, worktreeDir(parent.id), wt, projectProfile().depDirs);`，並刪掉原本那兩段（`excludePaths` 那行在 `addWorktree` 之前，順序不影響，因為 exclude 寫在共用的 `info/exclude`）。
    - 約 2260 行的 side-effect 過濾：`!/(^|\/)node_modules\//.test(p)` 改成依 `projectProfile().depDirs` 組：

```ts
  const depRe = new RegExp(`(^|/)(${projectProfile().depDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/`);
  const sideEffects = (await dirtyPaths(repo).catch(() => [])).filter((p) => !dirtyBefore.has(p) && !(projectProfile().depDirs.length && depRe.test(p)));
```
  - `cli.ts` 約 406 行的還原提示：「worktree 不含 node_modules，接續前請先在裡面安裝相依套件」改成「worktree 不含相依套件（依賴目錄），接續前請先在裡面安裝」。

- [ ] **Step 4：加車道的測試**：在建立車道的既有測試（`src/parallelEngine.test.ts` 或 `src/lanes.test.ts` 裡用 `node_modules` 的案例）旁，加一個 python 專案（`requirements.txt`＋`.venv` 目錄）案例，斷言車道 worktree 內 `.venv` 是 symlink、沒有 `node_modules`。若現有測試不易擴充，改為對 `linkDepDirs` 寫單元測試（需 export）。

- [ ] **Step 5：驗證**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6：更新 `README.md`**：「車道共用 node_modules」的敘述改成「共用依賴目錄（Node 的 `node_modules`、Python 的 `.venv`、Rust 的 `target`）」。

- [ ] **Step 7：Commit**

```bash
git add -A src README.md
git commit -m "車道與審查者的臨時 worktree 依 profile 共用依賴目錄

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5：守門與失敗輸出格式 profile 化（commit C，前半）

**Files:**
- Modify: `src/testGuard.ts`、`src/util.ts`、`src/packageExports.ts`（不改，只在 engine 呼叫前判斷）、`src/engine.ts`
- Test: `src/testGuard.test.ts`、`src/util.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `anyOf`、`testSourceOf`、`isSourceFile`、`EcosystemProfile`、`FailureFormat`。
- Produces（確切簽名）：
  - `sourceOfTest(profile: EcosystemProfile, file: string): string | undefined`（保留名稱，委派給 `testSourceOf`）
  - `violatingTestChanges(changed: string[], deleted: string[], testRe: RegExp, profile: EcosystemProfile): string[]`
  - `foreignFailingTests(output: string, taskTests: string[], profile: EcosystemProfile): string[]`
  - `weakenedChecks(diff: string, testRe: RegExp, profile: EcosystemProfile): Weakening[]`
  - `failureTail(s: string, max?: number, format?: FailureFormat): string`
  - `weakenedMessage(found: Weakening[]): string`（文字不再提 `@ts-ignore`）

- [ ] **Step 1：寫失敗的測試**（`src/testGuard.test.ts`；既有案例的呼叫全部補傳 `NODE_PROFILE`，其餘斷言不變）

```ts
import { NODE_PROFILE, PYTHON_PROFILE, GO_PROFILE } from "./profile.js";

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

  it("violatingTestChanges：測試檔連同被測檔一起刪除時放行", () => {
    const changed = ["tests/test_foo.py", "tests/foo.py"];
    expect(violatingTestChanges(changed, changed, pyTest, PYTHON_PROFILE)).toEqual([]);
    expect(violatingTestChanges(["tests/test_foo.py"], ["tests/test_foo.py"], pyTest, PYTHON_PROFILE)).toEqual(["tests/test_foo.py"]);
  });

  it("NEUTRAL profile：沒有任何規則時不擋", () => {
    const diff = ["+++ b/x.py", "+x = 1  # type: ignore"].join("\n");
    expect(weakenedChecks(diff, /x/, NEUTRAL_PROFILE)).toEqual([]);
  });
});
```
（`NEUTRAL_PROFILE` 也要 import。）

`src/util.test.ts` 新增：

```ts
it("failureTail：pytest 格式在輸出太長時保留被擠出尾端的失敗區塊", () => {
  const head = ["_____ test_bad _____", "    def test_bad():", ">       assert 1 == 2", "E       assert 1 == 2"].join("\n");
  const noise = Array.from({ length: 400 }, (_, i) => `tests/test_ok.py::test_${i} PASSED`).join("\n");
  const out = `${head}\n${noise}`;
  const shown = failureTail(out, 600, "pytest");
  expect(shown).toContain("test_bad");
  expect(shown).toContain("assert 1 == 2");
});
```

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/testGuard.test.ts src/util.test.ts`
Expected: FAIL（簽名與行為都還沒改）

- [ ] **Step 3：實作 `testGuard.ts`**
  - 移除 `SKIP_RE`、`SUPPRESS_RE`、`SOURCE_FILE`、`ASSERT_RE` 常數；頂端 `import { anyOf, isSourceFile, testSourceOf, type EcosystemProfile } from "./profile.js";`。
  - `sourceOfTest` 改為：

```ts
/** foo.test.ts → foo.ts（依生態系統的命名規則）；不符合命名時回傳 undefined */
export function sourceOfTest(profile: EcosystemProfile, file: string): string | undefined {
  return testSourceOf(profile, file);
}
```
  - `violatingTestChanges(changed, deleted, testRe, profile)`：內部 `sourceOfTest(f)` 改 `sourceOfTest(profile, f)`。
  - `foreignFailingTests(output, taskTests, profile)`：沒有 `profile.failureLine` 或 `profile.testFilePattern` 時回傳 `[]`（無法判斷，照常進行）；否則：

```ts
  const failureLine = profile.failureLine && new RegExp(profile.failureLine);
  const filePattern = profile.testFilePattern;
  if (!failureLine || !filePattern) return [];
  // ...原有的 plain、norm、isMine 不變
  for (const line of plain.split("\n")) {
    if (!failureLine.test(line)) continue;
    for (const m of line.matchAll(new RegExp(filePattern, "g"))) {
      if (!isMine(m[0])) foreign.add(m[0]);
    }
  }
```
  （pytest 的 `testFilePattern` 是 `[\w@.\/-]+\.py`，會把非測試的 `.py` 也撈到；所以在迴圈裡再用 `testRe` 無法取得——改在呼叫端 engine 傳入 `own` 與 `changed` 時已是測試檔。為避免誤抓被測檔，`foreignFailingTests` 只收錄「檔名符合 `testSourceOf` 有對應或符合 profile 的測試命名」的路徑：加一行 `if (profile.testSourcePairs.length && !testSourceOf(profile, m[0])) continue;`。Node 的 pair 規則與 `testFilePattern` 一致，行為不變。）
  - `weakenedChecks(diff, testRe, profile)`：

```ts
  const skipRe = anyOf(profile.skipPatterns);
  const suppressRe = anyOf(profile.suppressPatterns);
  const assertRe = profile.assertPattern ? new RegExp(profile.assertPattern) : undefined;
  // ...
    const skipped = isTest && skipRe ? net(lines, skipRe) : 0;
    const suppressed = suppressRe && isSourceFile(profile, file) ? net(lines, suppressRe) : 0;
    const lost = isTest && assertRe ? -net(lines, assertRe) : 0;
```
  - `weakenedMessage` 的 `label.suppress` 改為 `"新增抑制型別或 lint 的註解"`，說明文字「抑制型別或 lint」不變；同步 `Weakening.kind` 的註解（skip／suppress 的說明不再列 `@ts-ignore`）。
  - **`brokenPackageImport`、`packageImports`、`packageImportMap` 不動**（JS 專用，由 engine 以 `profile.packageProbe` 閘控）。

- [ ] **Step 4：實作 `util.ts`**：`failureBlocks` 與 `failureTail` 加格式：

```ts
import type { FailureFormat } from "./profile.js";

const BLOCK_STARTS: Record<Exclude<FailureFormat, "tap">, RegExp> = {
  pytest: /^_{3,} .+ _{3,}$/gm,
  go: /^--- FAIL.*$/gm,
  cargo: /^---- .+ stdout ----$/gm,
};
/** 非 TAP 格式的區塊結尾：下一個區塊開頭、摘要分隔線（===）、go 的 FAIL／ok 行或 cargo 的 failures: */
const BLOCK_STOP = /^(?:={3,}.*|FAIL\b.*|ok\b.*|failures:)$/m;

function failureBlocks(s: string, format: FailureFormat): { start: number; end: number }[] {
  if (format === "tap") return tapBlocks(s);
  const starts = [...s.matchAll(BLOCK_STARTS[format])].map((m) => m.index!);
  return starts.map((start, i) => {
    const limit = starts[i + 1] ?? s.length;
    const stop = BLOCK_STOP.exec(s.slice(start, limit));
    return { start, end: stop ? start + stop.index : limit };
  });
}
```
  把原本的 `failureBlocks` 函式改名為 `tapBlocks`（內容不變）；`failureTail(s, max = 4000, format: FailureFormat = "tap")` 內呼叫 `failureBlocks(s, format)`。預設值 `"tap"` 只是保持向下相容：engine 一律明確傳 profile 的格式；沒有格式（`failureFormat` 為 undefined）時傳 `undefined` 以外的值不合理，所以 engine 端用 `failureTail(output, undefined, profile.failureFormat)`，而 `failureTail` 內遇到 `format === undefined` 才退回只截尾端：把簽名改成 `format?: FailureFormat`，且 `if (!format) return tail(s, max)` 放在 `s.length <= max` 之後。預設值 `"tap"` 移除；既有 `util.test.ts` 的 TAP 案例改成明確傳 `"tap"`。

- [ ] **Step 5：更新 `engine.ts` 呼叫處**（用 `const profile = projectProfile();` 取得，同一個函式內重複用）
  - 1720、1814：`foreignFailingTests(red.output, tests, profile)`、`foreignFailingTests(green.output, own, profile)`。
  - 1781：`violatingTestChanges(changed, deleted, testRe, profile)`。
  - 1792、2331：`weakenedChecks(diff, testRe, profile)`。
  - 1726：`missingPackageExports` 前加閘：`const missing = profile.packageProbe ? await missingPackageExports(repo, ...) : [];`。
  - 1833：`brokenPackageImport` 前加閘：`const brokenImport = tdd && profile.packageProbe && run.taskBase ? ... : undefined;`。
  - 所有 `failureTail(x)`（1814 的訊息、1847、2113）改為 `failureTail(x, undefined, profile.failureFormat)`；2113 在 `util` 的另一個函式內，若沒有 `profile` 變數就在該函式取 `projectProfile()`。
  - `grep -rn "sourceOfTest" src` 找出其他呼叫者並補 `profile` 參數。

- [ ] **Step 6：驗證**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS（Node 既有測試只因補傳 `NODE_PROFILE` 而改，斷言不變）

- [ ] **Step 7：Commit 暫緩**，與 Task 6 同為 commit C；若要分開，這裡先 commit：

```bash
git add -A src
git commit -m "守門與失敗輸出格式依 profile 判斷：pytest、Go、Rust 專案的 skip、抑制、斷言與失敗區塊也有效

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6：generated 補缺（commit C，後半）

**Files:**
- Modify: `src/schemas.ts`（`DetectionProposal`）
- Modify: `src/generateDetected.ts`（`validateProposal`、`ValidateDeps`）
- Modify: `src/detectedFile.ts`（指紋、`effectiveDefaults`、新增 `mergeGeneratedProfile`）
- Modify: `src/engine.ts`（`detectWithAgent` 的觸發條件與提案驗證）
- Modify: `prompts/detect.md`
- Modify: `src/profile.ts`（新增 `profileGaps`、`mergeProfile`）
- Test: `src/profile.test.ts`、`src/generateDetected.test.ts`、`src/detectedFile.test.ts`、`src/detectAgent.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes：Task 1 的 profile；既有的 `validateProposal`、`DetectedFile`。
- Produces：
  - `schemas.ts`：`PatternProposal = z.object({ pattern: z.string(), example: z.string() })`；`DetectionProposal` 新增選填 `depDirs: string[]`、`skipDirs: string[]`、`sourceExts: string[]`、`skipPatterns: PatternProposal[]`、`suppressPatterns: PatternProposal[]`、`assertPattern: PatternProposal`、`failureLine: PatternProposal`、`failureFormat: FailureFormat`（用 `z.enum(["tap","pytest","go","cargo"])`）。
  - `profile.ts`：`profileGaps(p: EcosystemProfile): string[]`（回傳空的守門欄位名稱）、`mergeProfile(base: EcosystemProfile, extra: ProfileExtras): EcosystemProfile`，其中 `ProfileExtras` 為 `Partial<Pick<EcosystemProfile, "depDirs"|"skipDirs"|"sourceExts"|"skipPatterns"|"suppressPatterns"|"assertPattern"|"failureLine"|"failureFormat">>`。
  - `generateDetected.ts`：`ValidateDeps` 新增 `dirOk(dir: string): boolean`；`Validated` 新增 `profileExtras: ProfileExtras`。
  - `detectedFile.ts`：`DetectedFile` 繼承新欄位（已驗證後的字串，不含 `example`）。

- [ ] **Step 1：寫失敗的測試**

`src/profile.test.ts`：

```ts
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
```

`src/generateDetected.test.ts`（沿用該檔建立 `ValidateDeps` 的 helper，補 `dirOk`）：

```ts
it("新欄位：範例比對不到的正規表示式、不存在的目錄會被丟掉", async () => {
  const v = await validateProposal(
    { checks: [], skipPatterns: [{ pattern: "@slow\\b", example: "@slow" }, { pattern: "@fast\\b", example: "@slow" }], assertPattern: { pattern: "(", example: "x" },
      depDirs: [".venv", "nope"], failureFormat: "pytest" },
    { ...baseDeps, dirOk: (d) => d === ".venv" },
  );
  expect(v.profileExtras.skipPatterns).toEqual(["@slow\\b"]);
  expect(v.profileExtras.assertPattern).toBeUndefined();
  expect(v.profileExtras.depDirs).toEqual([".venv"]);
  expect(v.profileExtras.failureFormat).toBe("pytest");
  expect(v.dropped.map((d) => d.field).sort()).toEqual(["assertPattern", "depDirs", "skipPatterns"]);
});
```

`src/detectedFile.test.ts`：

```ts
it("已辨識的專案：generated 只補 profile 的空欄位，不改 install／test／checks", () => {
  const base = detectProjectDefaults(projectDir({ "requirements.txt": "pytest\n" }));
  const merged = mergeGeneratedProfile(base, { ...emptyDetected, assertPattern: "SHOULD_NOT_WIN" });
  expect(merged.install).toBe(base.install);
  expect(merged.profile.assertPattern).toBe(base.profile.assertPattern);
});
```
（`projectDir`、`emptyDetected` 用該檔現有的 helper 或在檔內補一個最小版本：`{ checks: [], fingerprint: "x", generatedAt: "", dropped: [] }`。）

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/profile.test.ts src/generateDetected.test.ts src/detectedFile.test.ts`
Expected: FAIL

- [ ] **Step 3：實作**
  - `profile.ts`：

```ts
export type ProfileExtras = Partial<Pick<EcosystemProfile, "depDirs" | "skipDirs" | "sourceExts" | "skipPatterns" | "suppressPatterns" | "assertPattern" | "failureLine" | "failureFormat">>;

/** 空著的守門欄位：有這些缺口且專案有測試檔時，才值得請 agent 補 */
export function profileGaps(p: EcosystemProfile): string[] {
  const gaps: string[] = [];
  if (!p.skipPatterns.length) gaps.push("skipPatterns");
  if (!p.suppressPatterns.length) gaps.push("suppressPatterns");
  if (!p.assertPattern) gaps.push("assertPattern");
  if (!p.failureLine) gaps.push("failureLine");
  return gaps;
}

const union = (a: readonly string[], b: readonly string[] = []) => [...new Set([...a, ...b])];

/** 只補不蓋：陣列取聯集，單值欄位只在原本沒有時才採用；提案不能關掉或放寬內建規則 */
export function mergeProfile(base: EcosystemProfile, extra: ProfileExtras): EcosystemProfile {
  return {
    ...base,
    depDirs: union(base.depDirs, extra.depDirs),
    skipDirs: union(base.skipDirs, extra.skipDirs),
    sourceExts: union(base.sourceExts, extra.sourceExts),
    skipPatterns: union(base.skipPatterns, extra.skipPatterns),
    suppressPatterns: union(base.suppressPatterns, extra.suppressPatterns),
    assertPattern: base.assertPattern ?? extra.assertPattern,
    failureLine: base.failureLine ?? extra.failureLine,
    failureFormat: base.failureFormat ?? extra.failureFormat,
  };
}
```
  - `schemas.ts`：在 `DetectionProposal` 前新增 `PatternProposal` 與 `FailureFormat` 的 zod enum，並加上述選填欄位；`DetectedFile`（`DetectionProposal.extend`）會繼承，但儲存的是驗證後的字串而非 `{pattern, example}`，所以 `DetectedFile` 改為：

```ts
export const DetectedFile = DetectionProposal.omit({ skipPatterns: true, suppressPatterns: true, assertPattern: true, failureLine: true }).extend({
  skipPatterns: z.array(z.string()).optional(),
  suppressPatterns: z.array(z.string()).optional(),
  assertPattern: z.string().optional(),
  failureLine: z.string().optional(),
  fingerprint: z.string(),
  generatedAt: z.string(),
  dropped: z.array(z.object({ field: z.string(), reason: z.string() })).default([]),
});
```
  - `generateDetected.ts`：`Validated` 改為 `Pick<DetectedFile, "install"|"test"|"checks"|"testPattern"|"dropped"> & { profileExtras: ProfileExtras }`；`ValidateDeps` 加 `dirOk(dir: string): boolean`；在 `validateProposal` 的 `testPattern` 區塊之後、`passedTest` 區塊之前加：

```ts
  const extras: ProfileExtras = {};
  const checkPattern = (field: string, p: { pattern: string; example: string }): string | undefined => {
    try {
      if (new RegExp(p.pattern).test(p.example)) return p.pattern;
      dropped.push({ field, reason: `範例沒有被這個規則比對到：${p.pattern}` });
    } catch {
      dropped.push({ field, reason: `不是合法的正規表示式：${p.pattern}` });
    }
    return undefined;
  };
  const listOf = (field: "skipPatterns" | "suppressPatterns") => (p[field] ?? []).map((x) => checkPattern(field, x)).filter((x): x is string => x !== undefined);
  const skip = listOf("skipPatterns");
  if (skip.length) extras.skipPatterns = skip;
  const suppress = listOf("suppressPatterns");
  if (suppress.length) extras.suppressPatterns = suppress;
  if (p.assertPattern) extras.assertPattern = checkPattern("assertPattern", p.assertPattern);
  if (p.failureLine) extras.failureLine = checkPattern("failureLine", p.failureLine);
  if (p.failureFormat) extras.failureFormat = p.failureFormat;
  for (const field of ["depDirs", "skipDirs"] as const) {
    const ok = (p[field] ?? []).filter((d) => deps.dirOk(d));
    const bad = (p[field] ?? []).filter((d) => !deps.dirOk(d));
    if (ok.length) extras[field] = ok;
    if (bad.length) dropped.push({ field, reason: `不存在也沒有被 .gitignore 忽略：${bad.join("、")}` });
  }
  if (p.sourceExts?.length) extras.sourceExts = p.sourceExts.filter((e) => /^\.\w+$/.test(e));
```
  並讓 `out.profileExtras = extras`（函式 `out` 初始值加 `profileExtras: {}`）。注意 `extras.assertPattern`／`failureLine` 為 undefined 時不要留下 key（`if` 後賦值 undefined 無妨，zod 的 optional 接受）。
  - `detectedFile.ts`：
    - `detectFingerprint(root)` 的 `parts` 再加一段 `eco:${detectProjectDefaults(root).ecosystem}`。
    - 新增並改寫：

```ts
export function mergeGeneratedProfile(base: ProjectDefaults, g: DetectedFile): ProjectDefaults {
  return { ...base, profile: mergeProfile(base.profile, g) };
}

/** 內建偵測；detected.json 的指紋相符時才疊上動態結果：未知類型整個疊上，已辨識的只補 profile 的缺欄位 */
export function effectiveDefaults(root: string): ProjectDefaults {
  const base = detectProjectDefaults(root);
  const generated = readDetected(root);
  if (!generated || generated.fingerprint !== detectFingerprint(root)) return base;
  return base.ecosystem === "unknown" ? mergeGeneratedProfile(overlayGenerated(base, generated), generated) : mergeGeneratedProfile(base, generated);
}
```
  （`mergeProfile(base.profile, g)` 接受的 `g` 含 `depDirs` 等同名欄位；型別上 `DetectedFile` 的 `failureFormat`／`depDirs`／`skipDirs`／`sourceExts`／`skipPatterns`／`suppressPatterns`／`assertPattern`／`failureLine` 與 `ProfileExtras` 相容。）
  - `engine.ts` 的 `detectWithAgent`：
    - 取代 `if (detectProjectDefaults(root).ecosystem !== "unknown") return;` 為：

```ts
    const base = detectProjectDefaults(root);
    const unknown = base.ecosystem === "unknown";
    // 已辨識的專案只在守門欄位有缺口、而且有測試檔時才請 agent 補
    if (!unknown && (!profileGaps(base.profile).length || !findFiles(root, new RegExp(base.testPattern ?? RepoConfig.parse({}).testPattern), base.profile.skipDirs, 2000).length)) return;
```
    - 「手寫設定已經四個欄位都有」那段只在 `unknown` 時適用：`if (unknown && rawConfig?.ok && [...])`。
    - 日誌文字依 `unknown` 區分：未知寫「🔎 專案類型未知，請 ${agent} 分析怎麼安裝、測試與檢查」；已辨識寫「🔎 ${base.manager} 專案的守門規則不完整，請 ${agent} 補充（${profileGaps(...).join("、")}）」。
    - 已辨識時提案的 `install`／`test`／`checks`／`testPattern` 一律忽略（`proposal = { checks: [], ...pickProfileFields(read.data) }`，只留新欄位），避免蓋掉內建指令。
    - `validateProposal` 的 deps 補 `dirOk: (d) => existsSync(join(ws.dir, d)) || gitIgnored(ws.dir, d)`；`gitIgnored` 用 `execFileSync("git", ["check-ignore", "-q", d], { cwd: ws.dir })`，不丟例外就是被忽略，丟例外回傳 false。
    - `writeDetected` 時把 `validated.profileExtras` 展開進檔案：`writeDetected(root, { ...validated, ...validated.profileExtras, fingerprint, ... })`（`profileExtras` 欄位本身不寫入：解構掉）。
    - 已辨識的專案保留訊息改為列出保留的 profile 欄位名稱。
  - `prompts/detect.md`：`<context>` 把「agentflowctl 無法辨識這個專案的類型（沒有 package.json、go.mod、Cargo.toml、pyproject.toml 等），需要你從專案本身找出答案。」改成「agentflowctl 需要你從專案本身找出答案：專案類型未知時是安裝、測試、檢查指令與測試檔命名；專案類型已知但守門規則不完整時是下面 output_format 裡的規則欄位。」`<output_format>` 的範例 JSON 補上新欄位與說明（每個規則附 `example`，必須是專案內真的出現過或會出現的一行程式碼；目錄必須真實存在；`failureFormat` 只能是 tap／pytest／go／cargo 之一；提案只能新增規則，不能放寬）。`<constraints>` 補「只提案專案實際使用的語法」。

- [ ] **Step 4：測試 `detectWithAgent`**（`src/detectAgent.test.ts`，沿用既有 stub agent 的寫法）：新增兩個案例——已辨識的 python 專案缺 `assertPattern` 時會呼叫 agent 且只寫入新欄位；欄位齊全的 node 專案不呼叫 agent。

- [ ] **Step 5：驗證**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6：更新 `README.md`**：偵測段落補「已辨識但守門規則不完整時，也會請一位 agent 補充（只能新增規則，經程式驗證；結果存進 `.agentflowctl/detected.json`）」。

- [ ] **Step 7：Commit**

```bash
git add -A src prompts README.md
git commit -m "已辨識專案的守門規則不完整時，請 agent 補充並由程式驗證

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7：prompt 變數注入（commit D）

**Files:**
- Modify: `src/engine.ts`（新增 `renderStage`，19 處改名）
- Modify: `prompts/spec.md`、`prompts/fast-plan.md`、`prompts/plan.md`、`prompts/implement-tests.md`、`prompts/implement-code.md`
- Test: `src/prompts.test.ts`、`src/engine.test.ts`
- Modify: `README.md`（如果有 prompt 變數說明，沒有就不改）

**Interfaces:**
- Consumes：`EcosystemProfile.hints`、`renderPrompt`。
- Produces：`engine.ts` 的 `renderStage(name: string, vars?: Record<string, string>): string`；prompt 可用變數 `{{manifestFiles}}`、`{{exampleSource}}`、`{{exampleTest}}`、`{{dependencyNote}}`。

- [ ] **Step 1：寫失敗的測試**（`src/prompts.test.ts`，沿用該檔既有的讀 prompts 目錄的寫法）

```ts
it("prompts 不寫死特定框架或專案檔：範例一律由 profile 的 hints 代入", () => {
  const forbidden = /vitest|package\.json|tsconfig|@testing-library|\bsrc\/form\.ts\b|foo\.test\.ts/;
  for (const file of readdirSync(new URL("../prompts/", import.meta.url))) {
    const text = readFileSync(new URL(`../prompts/${file}`, import.meta.url), "utf8");
    expect(forbidden.test(text), `${file} 含有寫死的框架字樣`).toBe(false);
  }
});

it("hints 的變數齊全：所有 profile 都能代入每個 prompt", () => {
  for (const p of [NODE_PROFILE, PYTHON_PROFILE, GO_PROFILE, RUST_PROFILE, NEUTRAL_PROFILE]) {
    expect(Object.keys(p.hints).sort()).toEqual(["dependencyNote", "exampleSource", "exampleTest", "manifestFiles"]);
  }
});
```

- [ ] **Step 2：確認失敗**

Run: `npx vitest run src/prompts.test.ts`
Expected: FAIL（`spec.md`、`fast-plan.md`、`plan.md`、`implement-tests.md`、`implement-code.md` 含禁用字樣）

- [ ] **Step 3：改 prompt 文字**（先用 `grep -n "vitest\|package.json\|tsconfig\|@testing-library\|src/form.ts\|foo.test.ts" prompts/*.md` 找出全部位置，下列是已知的）
  - `prompts/spec.md`、`prompts/fast-plan.md` 的「閱讀專案結構與相關程式碼（package.json、src/、既有測試、設定檔）」→「閱讀專案結構與相關程式碼（{{manifestFiles}}、既有測試、設定檔）」。
  - `prompts/plan.md`：任務 `description` 範例「`src/form.ts`」→「`{{exampleSource}}`」；`tdd` 說明裡的「build、CI、bundler、tsconfig」→「build、CI、bundler、型別或編譯設定」。`prompts/fast-plan.md` 的「`src/form.ts`」同樣改 `{{exampleSource}}`。
  - `prompts/implement-tests.md`：「只用專案已安裝版本支援的 API（例如 `renderHook` 在較舊的 @testing-library/react 不存在，要看 package.json 的實際版本），不要憑印象引入」→「只用專案已安裝版本支援的 API{{dependencyNote}}，不要憑印象引入」。
  - `prompts/implement-code.md`：「（`foo.ts` 與 `foo.test.ts`）」→「（`{{exampleSource}}` 與 `{{exampleTest}}`）」。
  - `prompts/plan-fix.md` 若也有同類字樣，一併處理。

- [ ] **Step 4：實作 `renderStage`**（`engine.ts`，放在 `projectProfile()` 旁）並用全域取代把引擎內所有 `renderPrompt(` 呼叫改成 `renderStage(`（`import` 行保留 `renderPrompt`，因為 `renderStage` 內用到）：

```ts
/** renderPrompt 加上目前專案生態系統的範例字串（hints）；呼叫端自己給的同名變數優先 */
function renderStage(name: string, vars: Record<string, string> = {}): string {
  return renderPrompt(name, { ...projectProfile().hints, ...vars });
}
```
  - 執行：`sed -i '' 's/renderPrompt("/renderStage("/g' src/engine.ts`（macOS 的 sed），再手動確認 `renderStage` 函式本體裡仍是 `renderPrompt(name, ...)`。
  - `detectWithAgent` 的 `renderPrompt("detect", {})` 改成 `renderStage("detect", {})` 即可（`projectProfile()` 在未知專案會給 `NEUTRAL_PROFILE`）。

- [ ] **Step 5：驗證**

Run: `pnpm run typecheck && pnpm test`
Expected: PASS；若有測試 stub 了 `renderPrompt` 或檢查 prompt 內容含 `package.json`，改為檢查代入後的內容。

- [ ] **Step 6：Commit**

```bash
git add -A src prompts
git commit -m "prompt 的範例與專案檔名改由 profile 的 hints 代入

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8：文件、spec 同步與端到端驗證

**Files:**
- Modify: `docs/superpowers/specs/2026-10-04-ecosystem-profile-design.md`、`AGENTS.md`、`README.md`、`docs/configuration.md`、`examples/flow.config.json`

- [ ] **Step 1：更新 spec** 的「與 spec 的三處差異」：把本計畫開頭那三點寫回 spec（Node 偵測依據、`failureFormat` 取代 `failureBlock`、`acceptanceChecks` 不需改、五個 commit）。

- [ ] **Step 2：更新 `AGENTS.md`**：在「架構」加一條 `profile.ts`：「各生態系統的差異（依賴目錄、守門規則、失敗輸出格式、prompt 範例）都是 `EcosystemProfile` 的資料；引擎不要再寫死 Node 的慣例，新增生態系統或欄位改這裡，並補 `profile.test.ts`。`detect.ts` 的 `ProjectDefaults.profile` 帶它，`engine.ts` 的 `projectProfile()` 取用；`detected.json` 只能補空欄位。」同時修正「設定」條目裡「其餘指令以 Vite + TS + Vitest 為底」→「沒有偵測結果就不安裝、不跑檢查」。

- [ ] **Step 3：`README.md`、`docs/configuration.md`、`examples/flow.config.json`** 全文搜尋 `vitest`、`Vite`、`node_modules`、`npx`，凡是描述「預設值」的敘述都改成偵測導向的說法；範例檔若把 vitest 當預設示範，保留為「範例」並註明只是示例。

- [ ] **Step 4：端到端驗證**（三個暫存專案，用 `pnpm dev` 跑到計畫階段即可，不必走完；目的是確認偵測、守門、prompt 變數都正常）
  1. Python：`mkdir -p /tmp/e2e-py/tests && cd /tmp/e2e-py && git init -q && printf 'pytest\n' > requirements.txt && printf 'def test_a():\n    assert 1 == 1\n' > tests/test_a.py && git add -A && git commit -qm init`，然後 `pnpm --dir <agentflowctl> dev config doctor`（在該目錄執行，cwd 要是 `/tmp/e2e-py`；若 CLI 不接受 `--dir`，先 `cd` 再執行 `node <agentflowctl>/dist/cli.js ...`）。確認輸出的偵測說明含 `.venv/bin/pytest` 與 pytest 的 testPattern。
  2. Go：`go.mod` ＋ `x_test.go`，確認 `go test ./...` 與 `_test\.go$`。
  3. 未知：只有 `README.md`，確認顯示「未辨識專案類型」且沒有錯誤。
  4. Node（本 repo 自己）：`pnpm dev config doctor` 的偵測結果與改動前相同（`git stash` 無關，直接對照 Task 3 之前的輸出：在 `main` 分支跑一次存檔比較）。
  若環境沒有 `go`／`python3`，只驗證偵測輸出，並在回報裡註明沒有實際跑測試指令。

- [ ] **Step 5：最終驗證**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: 全部通過

- [ ] **Step 6：Commit**

```bash
git add -A docs AGENTS.md README.md examples
git commit -m "文件與 spec 同步：EcosystemProfile 與偵測導向的預設

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## 自我審查

- **Spec 覆蓋**：分層與合併（Task 6 的 `mergeProfile`／`effectiveDefaults`）、profile 欄位（Task 1–2）、`DetectionProposal` 擴充與驗證（Task 6）、中性預設與 Node 偵測（Task 3）、pip venv（Task 3）、`depDirs`／`skipDirs`（Task 2、4）、守門與失敗格式含 `foreignFailingTests`（Task 5）、prompt 注入與禁字測試（Task 7）、文件與相容性（各 task 與 Task 8）、`acceptanceChecks.ts`（已含各語言工具，Task 8 的差異說明）。
- **名稱一致**：`projectProfile()`、`renderStage`、`linkDepDirs`、`mergeProfile`、`profileGaps`、`ProfileExtras`、`mergeGeneratedProfile`、`NODE_TEST_PATTERN` 在各 task 的定義與使用一致。
- **已知風險**：Task 3 會讓一批既有測試的期望被刻意修改，只准改三類（見 Step 5），其餘失敗就是實作錯；Task 6 的 `detectWithAgent` 觸發條件與提案過濾需實際讀過 `engine.ts:606-680` 後套用；Task 8 的 Go／Python 端到端驗證取決於本機有沒有對應工具。
