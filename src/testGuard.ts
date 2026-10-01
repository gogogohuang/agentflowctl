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
