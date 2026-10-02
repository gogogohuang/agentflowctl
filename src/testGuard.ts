// 綠燈階段的測試檔守門：實作不可動測試檔，唯一例外是「連同被測檔一起刪除」（例如移除舊 helper）。

/** foo.test.ts → foo.ts；不符合 .test／.spec 命名時回傳 undefined */
export function sourceOfTest(file: string): string | undefined {
  const m = file.match(/^(.*)\.(?:test|spec)(\.[cm]?[jt]sx?)$/);
  return m ? `${m[1]}${m[2]}` : undefined;
}

/**
 * 挑出綠燈階段違規的測試檔變更。
 * changed 是與測試 commit 相比有變動的全部檔案，deleted 是其中被刪除的。
 * 測試檔被刪除、而且對應的被測檔也一起被刪除時放行，其餘都算違規。
 */
export function violatingTestChanges(changed: string[], deleted: string[], testRe: RegExp): string[] {
  const gone = new Set(deleted);
  return changed.filter((f) => {
    if (!testRe.test(f)) return false;
    if (!gone.has(f)) return true;
    const src = sourceOfTest(f);
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
export function foreignFailingTests(output: string, taskTests: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const base = (f: string) => f.split("/").pop() ?? f;
  const mine = new Set(taskTests.map(base));
  const foreign = new Set<string>();
  for (const line of plain.split("\n")) {
    if (!/\bFAIL\b|[❯×✗✕]/.test(line)) continue;
    for (const m of line.matchAll(/[\w@.\/-]+\.(?:test|spec)\.[cm]?[jt]sx?/g)) {
      if (!mine.has(base(m[0]))) foreign.add(m[0]);
    }
  }
  return [...foreign];
}
