/**
 * 決定每個步驟由哪個 agent 執行。
 *
 * 規則只有三條：
 * 1. 審查者不能是最後寫程式的 agent。
 * 2. 開啟 tddSplit 時，同一個任務的測試與實作由不同 agent 負責。
 * 3. 所有選擇都沿著同一個輪替順序（cycle）前進，所以不同公司的模型會輪流扮演各個角色。
 */

/** 從 from 的下一位開始，找第一個不在 exclude 裡的 agent；全部被排除時退回下一位（單一 agent 也能運作） */
export function nextAfter(cycle: string[], from: string | undefined, exclude: string[] = []): string {
  const n = cycle.length;
  const start = from === undefined ? -1 : cycle.indexOf(from);
  for (let i = 1; i <= n; i++) {
    const candidate = cycle[(start + i + n) % n]!;
    if (!exclude.includes(candidate)) return candidate;
  }
  return cycle[(start + 1 + n) % n]!;
}

export const specAgent = (cycle: string[]) => cycle[0]!;
export const planAgent = (cycle: string[]) => cycle[0]!;

/** 第 i 個任務的測試由輪替順序的第 i 位負責，實作交給下一位 */
export function taskAgents(cycle: string[], taskIndex: number, tddSplit: boolean): { tests: string; code: string } {
  const tests = cycle[taskIndex % cycle.length]!;
  return { tests, code: tddSplit ? nextAfter(cycle, tests, [tests]) : tests };
}

/** 從最後寫程式的 agent 之後，依序挑出 quorum 位不重複、而且不是作者的 reviewer */
export function reviewers(cycle: string[], lastWriter: string | undefined, quorum: number): string[] {
  const picked: string[] = [];
  let cursor = lastWriter;
  for (let i = 0; i < cycle.length && picked.length < quorum; i++) {
    const next = nextAfter(cycle, cursor, [...(lastWriter ? [lastWriter] : []), ...picked]);
    if (picked.includes(next) || (next === lastWriter && cycle.length > 1)) break;
    picked.push(next);
    cursor = next;
  }
  return picked.length ? picked : [nextAfter(cycle, lastWriter)];
}

/**
 * 誰來修正：
 * - verify 失敗（型別、lint、建置這類機械性錯誤）：交給最後寫程式的 agent
 * - review 要求修改：ring 策略輪到 reviewer 的下一位；author 策略交回作者
 */
export function fixAgent(
  cycle: string[],
  opts: { source: "verify" | "review"; strategy: "ring" | "author"; lastWriter?: string; lastReviewer?: string },
): string {
  if (opts.source === "verify" || opts.strategy === "author") return opts.lastWriter ?? cycle[0]!;
  return nextAfter(cycle, opts.lastReviewer, opts.lastReviewer ? [opts.lastReviewer] : []);
}

/** 計畫修正者：ring 策略輪到審查者的下一位；author 策略交回計畫作者 */
export function planFixAgent(
  cycle: string[],
  opts: { strategy: "ring" | "author"; planWriter?: string; planReviewer?: string },
): string {
  if (opts.strategy === "author") return opts.planWriter ?? cycle[0]!;
  return nextAfter(cycle, opts.planReviewer, opts.planReviewer ? [opts.planReviewer] : []);
}

/**
 * 仲裁小組：
 * - 有第三方（作者與最後審查者以外的 agent）→ 由第三方單獨仲裁
 * - 只有兩家 → 兩家各自在全新 context 中雙盲仲裁，避免讓一直反對的審查者同時當裁判
 * - 只有一家 → 只能由它自己仲裁
 */
export function arbiterPanel(cycle: string[], writer?: string, reviewer?: string): string[] {
  const involved = [writer, reviewer].filter((x): x is string => Boolean(x));
  const third = cycle.find((c) => !involved.includes(c));
  if (third) return [third];
  return [...new Set(cycle)];
}

/**
 * 代打人選：原本的 agent 可用就用它；額度用完時，沿輪替順序找下一位還有額度的 agent。
 * 全部都用完時回傳 undefined。
 */
export function availableAgent(cycle: string[], preferred: string, exhausted: string[]): string | undefined {
  if (!exhausted.includes(preferred)) return preferred;
  const next = nextAfter(cycle, preferred, exhausted);
  return exhausted.includes(next) ? undefined : next;
}
