// 綠燈階段的測試檔守門：實作不可動測試檔，唯一例外是「連同被測檔一起刪除」（例如移除舊 helper）。
import { anyOf, compileOrUndefined, isSourceFile, MAX_MATCH_LINE, testSourceOf, type EcosystemProfile } from "./profile.js";

/** foo.test.ts → foo.ts（依生態系統的命名規則）；不符合命名時回傳 undefined */
export function sourceOfTest(profile: EcosystemProfile, file: string): string | undefined {
  return testSourceOf(profile, file);
}

/**
 * 挑出綠燈階段違規的測試檔變更。
 * changed 是與測試 commit 相比有變動的全部檔案，deleted 是其中被刪除的。
 * 測試檔被刪除、而且對應的被測檔也一起被刪除時放行，其餘都算違規。
 */
export function violatingTestChanges(changed: string[], deleted: string[], testRe: RegExp, profile: EcosystemProfile): string[] {
  const gone = new Set(deleted);
  return changed.filter((f) => {
    if (!testRe.test(f)) return false;
    if (!gone.has(f)) return true;
    const src = sourceOfTest(profile, f);
    return !(src && gone.has(src));
  });
}

/** 從測試檔原始碼取出「由套件（非相對路徑、非別名）匯入」的具名符號，依套件名分組 */
export function packageImportMap(source: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, list = "", spec = ""] = m;
    if (/^[./~]|^@\//.test(spec)) continue;
    const names = map.get(spec) ?? new Set<string>();
    for (const part of list.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
    map.set(spec, names);
  }
  return map;
}

/** 由套件匯入的具名符號（不分套件） */
export function packageImports(source: string): Set<string> {
  return new Set([...packageImportMap(source).values()].flatMap((names) => [...names]));
}

/**
 * 測試輸出是否顯示「測試呼叫了套件沒有的匯出」（例如舊版 @testing-library/react 沒有 renderHook）。
 * 這種失敗與實作無關，實作者再怎麼改都不會綠；只認「X is not a function」且 X 是測試檔由套件匯入的符號，
 * 避免把「測試呼叫尚未實作的專案函式」誤判成測試本身的錯。
 */
export function brokenPackageImport(output: string, imports: Set<string>): string | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const m of plain.matchAll(/(?:^|[^\w.$])(\w+) is not a function/g)) {
    const name = m[1];
    if (name && imports.has(name)) return name;
  }
  return undefined;
}

/**
 * 紅燈階段的全套測試失敗時，挑出「失敗的不是本任務寫的」測試檔。
 * 紅燈跑在實作之前，所以別的測試檔失敗代表分支上早就壞了（例如平行車道合併後語意衝突），
 * 實作者修不了也不該修，繼續下去只會在綠燈原地打轉。
 * 只看含 FAIL／❯／×／✗／✕ 的行，避免把通過（✓）的檔案算進來；認不出任何失敗的測試檔時回傳空陣列（無法判斷，照常進行）。
 */
export function foreignFailingTests(output: string, taskTests: string[], profile: EcosystemProfile): string[] {
  // 規則無法編譯時停用這個判斷；每行只比對前 MAX_MATCH_LINE 個字元，避免長行讓同步比對卡住整個引擎
  const failureLine = compileOrUndefined(profile.failureLine);
  const filePattern = compileOrUndefined(profile.testFilePattern, "g");
  if (!failureLine || !filePattern) return [];
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  // 輸出的路徑可能相對於不同目錄，以路徑結尾比對；只比檔名會把同名的別處測試誤認成本任務的
  const norm = (f: string) => f.replace(/^\.\//, "");
  const isMine = (f: string) => taskTests.some((t) => norm(t) === norm(f) || norm(t).endsWith(`/${norm(f)}`) || norm(f).endsWith(`/${norm(t)}`));
  const foreign = new Set<string>();
  for (const full of plain.split("\n")) {
    const line = full.slice(0, MAX_MATCH_LINE);
    if (!failureLine.test(line)) continue;
    for (const m of line.matchAll(filePattern)) {
      // testFilePattern 可能撈到非測試檔（例如 pytest 的 .py）：有命名規則時只收有對應被測檔的路徑
      if (profile.testSourcePairs.length && !testSourceOf(profile, m[0])) continue;
      if (!isMine(m[0])) foreign.add(m[0]);
    }
  }
  return [...foreign];
}

export interface Weakening {
  file: string;
  /** skip＝新增跳過測試的標記；suppress＝新增抑制型別或 lint 的註解；assertions＝測試檔的斷言變少 */
  kind: "skip" | "suppress" | "assertions";
  count: number;
}

/**
 * 從 unified diff 找出「讓檢查變容易過」的變更。以每個檔案新增與移除的行數相抵，所以搬移程式碼不會誤判。
 * skip／suppress 沒有正當理由；assertions 可能是合理地刪掉重複的斷言，由呼叫端決定是否擋下。
 * .flow/ 是交接檔，不看。規則無法編譯時該守門停用，不丟例外。
 */
export function weakenedChecks(diff: string, testRe: RegExp, profile: EcosystemProfile): Weakening[] {
  const skipRe = anyOf(profile.skipPatterns);
  const suppressRe = anyOf(profile.suppressPatterns);
  const assertRe = compileOrUndefined(profile.assertPattern);
  const files = new Map<string, { added: string[]; removed: string[] }>();
  let current: { added: string[]; removed: string[] } | undefined;
  let name = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      name = line.slice(4).replace(/^b\//, "");
      current = name === "/dev/null" || name.startsWith(".flow/") ? undefined : (files.get(name) ?? files.set(name, { added: [], removed: [] }).get(name));
    } else if (line.startsWith("--- ")) {
      current = undefined;
    } else if (current && line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (current && line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }
  // 每行只比對前 MAX_MATCH_LINE 個字元：規則可能來自 agent 提案，長行配上回溯會讓同步比對卡住整個引擎
  const hits = (ls: string[], re: RegExp) => ls.filter((l) => re.test(l.slice(0, MAX_MATCH_LINE))).length;
  const net = (lines: { added: string[]; removed: string[] }, re: RegExp) => hits(lines.added, re) - hits(lines.removed, re);
  const found: Weakening[] = [];
  for (const [file, lines] of files) {
    const isTest = testRe.test(file);
    const skipped = isTest && skipRe ? net(lines, skipRe) : 0;
    if (skipped > 0) found.push({ file, kind: "skip", count: skipped });
    const suppressed = suppressRe && isSourceFile(profile, file) ? net(lines, suppressRe) : 0;
    if (suppressed > 0) found.push({ file, kind: "suppress", count: suppressed });
    const lost = isTest && assertRe ? -net(lines, assertRe) : 0;
    if (lost > 0) found.push({ file, kind: "assertions", count: lost });
  }
  return found;
}

export function weakenedMessage(found: Weakening[]): string {
  const label = { skip: "新增 skip／only／todo", suppress: "新增抑制型別或 lint 的註解", assertions: "斷言變少" } as const;
  return `這次變更讓檢查變得比較容易通過，已還原你的變更：${found.map((w) => `${w.file}（${label[w.kind]} ${w.count} 處）`).join("、")}。請從根本原因修正，不要用跳過測試、抑制型別或 lint、減少斷言的方式讓檢查通過；測試本身確實有誤時，只修正有誤的斷言並在 <concerns> 說明理由。`;
}
