/**
 * 決定每個步驟由哪個 agent 執行。
 *
 * 規則只有四條：
 * 1. 審查者不能是最後寫程式的 agent，多位審查者彼此不重複。
 * 2. 開啟 tddSplit 時，同一個任務的測試與實作由不同 agent 負責。
 * 3. 人選隨機決定，不依 cycle 的順序。cycle 只代表有哪些 agent 參與。
 * 4. 任務的測試、實作、任務審查依同一個隨機順序輪流交換，讓各家用量平均。
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
 * 任務的角色輪流交換，讓各家用量平均：整個 run 用同一個洗好的順序，
 * 第 i 個任務由 order[i] 寫測試、order[i+1] 寫實作、order[i+2] 做任務審查（都取餘數）。
 * 三家時每三個任務各家剛好把三種角色各做一次；兩家時測試與實作每個任務互換。
 */
export function taskAgents(
  cycle: string[],
  taskIndex: number,
  tddSplit: boolean,
  seed: string,
): { tests: string; code: string; review: string } {
  const order = shuffled(cycle, `${seed}:tasks`);
  const at = (offset: number) => order[(taskIndex + offset) % order.length]!;
  const tests = at(0);
  const code = tddSplit ? at(1) : tests;
  // 兩家時沒有第三方，任務審查只能由實作者以外的測試作者負責
  const review = order.length >= 3 ? at(tddSplit ? 2 : 1) : order.find((c) => c !== code) ?? code;
  return { tests, code, review };
}

/**
 * 隨機挑出 quorum 位彼此不重複、而且不是最後作者的 reviewer；任務審查優先避開測試作者。
 * prefer 是輪到的審查者：只要不是最後作者就排第一位（任務修正後重審仍由同一位審查）。
 */
export function reviewers(
  cycle: string[],
  lastWriter: string | undefined,
  quorum: number,
  seed: string,
  testAuthor?: string,
  prefer?: string,
): string[] {
  const candidates = shuffled(cycle.filter((c) => c !== lastWriter), seed);
  const preferred = testAuthor ? candidates.filter((c) => c !== testAuthor) : candidates;
  const fallback = testAuthor ? candidates.filter((c) => c === testAuthor) : [];
  const ranked = [...preferred, ...fallback];
  const first = prefer && ranked.includes(prefer) ? [prefer] : [];
  const picked = [...first, ...ranked.filter((c) => c !== prefer)].slice(0, quorum);
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
