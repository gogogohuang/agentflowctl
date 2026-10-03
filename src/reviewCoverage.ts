// 程式碼審查結果與驗收條件的對照：每條該審的驗收條件都要有回報，額外發現要有證據。
// 只檢查 review.json 的結構，不判斷審查者說得對不對。

import type { ReviewResult } from "./schemas.js";

type ReviewItem = ReviewResult["items"][number];

const AC_ID = /^AC-\d+$/;

/** criterion 是驗收條件編號的項目；其餘是審查者自己提出的額外發現 */
export const isAcceptanceItem = (item: ReviewItem): boolean => AC_ID.test(item.criterion.trim());

/** 沒通過的項目依「對應驗收條件」與「額外發現」分開 */
export function splitUnmet(items: readonly ReviewItem[]): { acceptance: ReviewItem[]; extra: ReviewItem[] } {
  const unmet = items.filter((item) => item.status !== "met");
  return { acceptance: unmet.filter(isAcceptanceItem), extra: unmet.filter((item) => !isAcceptanceItem(item)) };
}

/**
 * 回傳不合格的原因（可直接回饋給審查者），合格時回傳 undefined。
 * expected：這次審查範圍內每一條都要回報的驗收條件；known：整份驗收條件，用來擋掉憑空捏造的編號。
 * 範圍外但真實存在的驗收條件編號不處理（任務審查時其他任務的條件）。
 */
export function checkReviewCoverage(review: ReviewResult, expected: readonly string[], known: ReadonlySet<string>): string | undefined {
  const reported = new Set(review.items.filter(isAcceptanceItem).map((item) => item.criterion.trim()));
  const errors: string[] = [];
  const unknown = [...reported].filter((id) => !known.has(id));
  if (unknown.length) errors.push(`items 提到不存在的驗收條件：${unknown.join("、")}`);
  const missing = expected.filter((id) => !reported.has(id));
  if (missing.length) errors.push(`沒有逐條回報驗收條件：${missing.join("、")}。每一條都要在 items 出現一筆，通過寫 met，未通過寫 not_met 或 partial`);
  const bare = review.items.filter((item) => !isAcceptanceItem(item) && item.status !== "met" && !item.evidence.trim());
  if (bare.length) errors.push(`額外發現必須在 evidence 寫出檔案位置或檢查證據：${bare.map((item) => item.criterion).join("、")}`);
  return errors.length ? errors.join("\n") : undefined;
}
