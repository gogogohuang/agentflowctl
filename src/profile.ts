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
  skipDirs: [".git", ".agentflowctl", ".flow", ".worktree", ".worktrees", "dist", "build", "node_modules", "venv", ".venv", "target", "__pycache__"],
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
  skipDirs: NEUTRAL_PROFILE.skipDirs,
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
  skipDirs: [...NEUTRAL_PROFILE.skipDirs, ".pytest_cache"],
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
  skipDirs: NEUTRAL_PROFILE.skipDirs,
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

/** 目錄提案只收單一層、看起來像一般目錄名的字串（例如 .venv、node_modules），擋掉空字串、.、..、路徑與以 - 開頭的值 */
export function isSafeDirName(d: string): boolean {
  return d !== "." && d !== ".." && /^[A-Za-z0-9_.][\w.-]*$/.test(d);
}

/**
 * 引擎自己會建立或依賴的目錄，不能當依賴目錄：臨時 worktree 會先複製 .flow/ 再建 symlink，撞名會讓每次審查都失敗；
 * symlink 到 .git 或 .agentflowctl 則會讓審查者與車道碰到引擎的資料。比對不分大小寫（macOS 預設的檔案系統不分）。
 */
const RESERVED_DEP_DIRS = new Set([".git", ".flow", ".agentflowctl", ".worktree", ".worktrees", "tmp-review"]);

/** 依賴目錄名稱：單一層的一般目錄名，而且不是引擎保留的名稱 */
export function isSafeDepDirName(d: string): boolean {
  return isSafeDirName(d) && !RESERVED_DEP_DIRS.has(d.toLowerCase());
}

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
