/**
 * 決定每個步驟由哪個 agent 執行。
 *
 * 規則只有三條：
 * 1. 審查者不能是最後寫程式的 agent，多位審查者彼此不重複。
 * 2. 開啟 tddSplit 時，同一個任務的測試與實作由不同 agent 負責。
 * 3. 人選隨機決定，不依 cycle 的順序。cycle 只代表有哪些 agent 參與。
 *
 * 隨機以 seed（run id 加上步驟與輪次）決定：同一個 run 的同一步驟重算時會得到同樣的人，
 * 所以 resume、或同一步驟在不同地方重算時結果一致。
 */

/** FNV-1a 雜湊：把 seed 字串轉成 32 位元整數 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：由 seed 決定的亂數產生器 */
function rng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由 seed 決定的洗牌，不改動原陣列 */
export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const rand = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 隨機挑一位不在 exclude 裡的 agent；全部被排除時退回任一位（單一 agent 也能運作） */
export function pick(cycle: string[], seed: string, exclude: string[] = []): string {
  const order = shuffled(cycle, seed);
  return order.find((c) => !exclude.includes(c)) ?? order[0]!;
}

/** 規格與計畫由同一位撰寫，計畫審查才能同時避開兩者的作者 */
export const specAgent = (cycle: string[], seed: string) => pick(cycle, `${seed}:author`);
export const planAgent = specAgent;

/**
 * 每 cycle.length 個任務為一輪，每輪洗一次牌，所以每家輪完一次才會再輪到；
 * 換輪時若新一輪第一位和上一輪最後一位相同，就把它往後移，避免同一家連續撰寫測試。
 */
function taskBag(cycle: string[], seed: string, bag: number): string[] {
  const order = shuffled(cycle, `${seed}:tasks:${bag}`);
  if (bag === 0 || order.length < 2) return order;
  const prevLast = taskBag(cycle, seed, bag - 1).at(-1);
  return order[0] === prevLast ? [...order.slice(1), order[0]!] : order;
}

/** 第 i 個任務的測試作者從洗好的牌依序取；實作者隨機挑一位測試作者以外的 agent */
export function taskAgents(cycle: string[], taskIndex: number, tddSplit: boolean, seed: string): { tests: string; code: string } {
  const n = cycle.length;
  const tests = taskBag(cycle, seed, Math.floor(taskIndex / n))[taskIndex % n]!;
  return { tests, code: tddSplit ? pick(cycle, `${seed}:code:${taskIndex}`, [tests]) : tests };
}

/** 隨機挑出 quorum 位彼此不重複、而且不是作者的 reviewer */
export function reviewers(cycle: string[], lastWriter: string | undefined, quorum: number, seed: string): string[] {
  const picked = shuffled(cycle.filter((c) => c !== lastWriter), seed).slice(0, quorum);
  return picked.length ? picked : [lastWriter ?? cycle[0]!];
}

/**
 * 誰來修正：
 * - verify 失敗（型別、lint、建置這類機械性錯誤）：交給最後寫程式的 agent
 * - review 要求修改：ring 策略隨機挑一位 reviewer 以外的 agent；author 策略交回作者
 */
export function fixAgent(
  cycle: string[],
  opts: { source: "verify" | "review"; strategy: "ring" | "author"; lastWriter?: string; lastReviewer?: string; seed: string },
): string {
  if (opts.source === "verify" || opts.strategy === "author") return opts.lastWriter ?? cycle[0]!;
  return pick(cycle, opts.seed, opts.lastReviewer ? [opts.lastReviewer] : []);
}

/** 計畫修正者：ring 策略隨機挑一位審查者以外的 agent；author 策略交回計畫作者 */
export function planFixAgent(
  cycle: string[],
  opts: { strategy: "ring" | "author"; planWriter?: string; planReviewer?: string; seed: string },
): string {
  if (opts.strategy === "author") return opts.planWriter ?? cycle[0]!;
  return pick(cycle, opts.seed, opts.planReviewer ? [opts.planReviewer] : []);
}

/**
 * 仲裁小組：
 * - 有第三方（作者與最後審查者以外的 agent）→ 隨機挑一位第三方單獨仲裁
 * - 只有兩家 → 兩家各自在全新 context 中雙盲仲裁，避免讓一直反對的審查者同時當裁判
 * - 只有一家 → 只能由它自己仲裁
 */
export function arbiterPanel(cycle: string[], seed: string, writer?: string, reviewer?: string): string[] {
  const involved = [writer, reviewer].filter((x): x is string => Boolean(x));
  const third = shuffled(cycle, seed).find((c) => !involved.includes(c));
  if (third) return [third];
  return [...new Set(cycle)];
}

/**
 * 代打人選：原本的 agent 可用就用它；額度用完時，隨機挑一位還有額度的 agent。
 * 全部都用完時回傳 undefined。
 */
export function availableAgent(cycle: string[], preferred: string, exhausted: string[], seed: string): string | undefined {
  if (!exhausted.includes(preferred)) return preferred;
  return shuffled(cycle, seed).find((c) => !exhausted.includes(c));
}
