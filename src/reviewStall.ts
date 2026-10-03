/** 整體審查連續幾次回報同一組未通過的驗收條件就停下等人 */
export const REVIEW_STALL_PAUSE_AFTER = 3;

/** 審查意見裡未通過的驗收條件（`AC-n` 加狀態）排序後的文字；額外發現與備註措辭不算 */
export function unmetCriteriaKey(issueLines: readonly string[]): string {
  const keys = new Set<string>();
  for (const line of issueLines) {
    const m = /<issue criterion="(AC-\d+)" status="([^"]*)"/.exec(line);
    if (m) keys.add(`${m[1]}:${m[2]}`);
  }
  return [...keys].sort().join(",");
}

/** 這次的未通過條件和上次相同就累計，不同就從 1 重數；沒有任何 AC 未通過（只剩額外發現）不累計 */
export function nextReviewStall(prev: { key: string; count: number } | undefined, key: string): { key: string; count: number } | undefined {
  if (!key) return undefined;
  return prev?.key === key ? { key, count: prev.count + 1 } : { key, count: 1 };
}
