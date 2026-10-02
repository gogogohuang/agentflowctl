import { shuffled } from "./roles.js";
import type { DivergeFrame, DivergePick } from "./schemas.js";

export const DIVERGE_CATEGORIES = ["tests_not_green", "tests_invalid", "tests_not_written"] as const;
export const DIVERGE_FRAMES: DivergeFrame[] = ["acceptance", "split", "invert"];

export function divergeStamp(taskId: string, phase: "tests" | "code", attempts: number, testsRedos: number): string {
  return `${taskId}:${phase}:${attempts}:${testsRedos}`;
}

export interface DivergeTrigger {
  enabled: boolean;
  after: number;
  phase: "tests" | "code";
  taskId: string;
  attempts: Record<string, number>;
  testsRedos?: number;
  retries: { key: string; category: string }[];
  lastStamp?: string;
  /** 上一次發散當下的 retries 筆數；連續合格只算這之後新增的 */
  since?: number;
}

export interface DivergeExcludeOpts {
  phase: "tests" | "code";
  testsRedos?: number;
  lastWriter?: string;
  lastTestsAuthor?: string;
  testsAgent: string;
  codeAgent: string;
}

function lastFor(retries: DivergeTrigger["retries"], key: string): string | undefined {
  return [...retries].reverse().find((item) => item.key === key)?.category;
}

function eligible(category: string | undefined): boolean {
  return category !== undefined && (DIVERGE_CATEGORIES as readonly string[]).includes(category);
}

/** 同一 key 從最新往回數的連續合格筆數；其他 key 略過，不合格分類中斷；只看 since 之後新增的 */
export function consecutiveEligible(retries: DivergeTrigger["retries"], key: string, since = 0): number {
  let n = 0;
  for (const item of retries.slice(since).reverse()) {
    if (item.key !== key) continue;
    if (!eligible(item.category)) break;
    n++;
  }
  return n;
}

/** 綠燈失敗／redoTests 不會留下 lastWriter；redoTests 還會清掉 lastTestsAuthor，所以空時改看 taskAgents */
export function divergeExclude(opts: DivergeExcludeOpts): string | undefined {
  const bounced = opts.phase === "tests" && (opts.testsRedos ?? 0) > 0;
  const role = bounced || opts.phase === "code" ? opts.codeAgent : opts.testsAgent;
  return opts.lastWriter ?? opts.lastTestsAuthor ?? role;
}

export function shouldDiverge(opts: DivergeTrigger): boolean {
  if (!opts.enabled) return false;
  const attempts = opts.attempts[`${opts.taskId}:${opts.phase}`] ?? 0;
  const stamp = divergeStamp(opts.taskId, opts.phase, attempts, opts.testsRedos ?? 0);
  if (opts.lastStamp === stamp) return false;
  // 只在連續合格剛好達到門檻的那一次發散，之後同一 streak 不再付第二次錢
  if (consecutiveEligible(opts.retries, `${opts.taskId}:${opts.phase}`, opts.since ?? 0) === opts.after) return true;
  // 剛從綠燈退回測試、tests 還沒自己失敗過；testsRedos 每增加一次才算新的一輪。
  // 發散後 since 會移到目前筆數，所以回到 code 階段時 T-1:code 的舊失敗不會再湊滿門檻
  if (opts.phase === "tests" && attempts === 0 && (opts.testsRedos ?? 0) > 0
    && lastFor(opts.retries, `${opts.taskId}:code`) === "tests_invalid") return true;
  return false;
}

export function selectFrames(seed: string, n: number): DivergeFrame[] {
  return shuffled(DIVERGE_FRAMES, `${seed}:frames`).slice(0, n);
}

export function formatDivergeFeedback(pick: DivergePick): string {
  return [
    "",
    "## 發散結論",
    "",
    `選了 \`${pick.pick}\`（建議 ${pick.action}）。`,
    "",
    pick.rationale,
    "",
    `下一動：${pick.nextStep}`,
    "",
  ].join("\n");
}
