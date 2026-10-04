import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { FailureFormat } from "./profile.js";

export function tail(s: string, max = 4000): string {
  return s.length <= max ? s : `…（前略）\n${s.slice(-max)}`;
}

const FAILURE_BLOCK_MAX = 800;

/** node:test（TAP）輸出裡每個 `not ok` 區塊：從 `not ok` 那行到結尾的 `...` 為止 */
function tapBlocks(s: string): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  const re = /^not ok .*$/gm;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const close = s.indexOf("\n  ...", m.index);
    const next = s.indexOf("\nok ", m.index);
    const end = close >= 0 && (next < 0 || close < next) ? close + "\n  ...".length : m.index + m[0].length;
    blocks.push({ start: m.index, end });
    re.lastIndex = end;
  }
  return blocks;
}

const BLOCK_STARTS: Record<Exclude<FailureFormat, "tap">, RegExp> = {
  pytest: /^_{3,} .+ _{3,}$/gm,
  go: /^--- FAIL.*$/gm,
  cargo: /^---- .+ stdout ----$/gm,
};
/** 非 TAP 格式的區塊結尾：下一個區塊開頭、摘要分隔線（===）、go 的 FAIL／ok 行、cargo 的 failures: 或 pytest -v 的 PASSED 行 */
const BLOCK_STOP = /^(?:={3,}.*|FAIL\b.*|ok\b.*|failures:|.*\bPASSED\b.*)$/m;

function failureBlocks(s: string, format: FailureFormat): { start: number; end: number }[] {
  if (format === "tap") return tapBlocks(s);
  const starts = [...s.matchAll(BLOCK_STARTS[format])].map((m) => m.index!);
  return starts.map((start, i) => {
    const limit = starts[i + 1] ?? s.length;
    const stop = BLOCK_STOP.exec(s.slice(start, limit));
    return { start, end: stop ? start + stop.index : limit };
  });
}

/**
 * 同 `tail`，但輸出太長、失敗的測試被擠出尾端時，先列出被截掉的失敗區塊（TAP 把每個失敗連同錯誤訊息放在原處，
 * 後面還有一大串通過的測試）。否則給作者看的 feedback 只剩一堆 ok，看不到為什麼失敗。
 */
export function failureTail(s: string, max = 4000, format?: FailureFormat): string {
  if (s.length <= max) return s;
  if (!format) return tail(s, max);
  const lost = failureBlocks(s, format).filter((b) => b.start < s.length - max);
  if (!lost.length) return tail(s, max);
  const tailLen = Math.floor(max / 2);
  const shown: string[] = [];
  let used = 0;
  let tailStart = s.length - tailLen;
  for (const b of lost) {
    if (b.start >= tailStart) break;
    const text = s.slice(b.start, b.end);
    const clipped = text.length > FAILURE_BLOCK_MAX ? `${text.slice(0, FAILURE_BLOCK_MAX)}…` : text;
    if (used + clipped.length > max - tailLen) break;
    shown.push(clipped);
    used += clipped.length;
    tailStart = Math.max(tailStart, b.end);
  }
  if (!shown.length) return tail(s, max);
  return `…（前略；先列出被截掉的失敗測試）\n${shown.join("\n")}\n…（中略）\n${s.slice(tailStart)}`;
}

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

/** 讀取 prompts/<name>.md 並代入 {{變數}} */
export function renderPrompt(name: string, vars: Record<string, string> = {}): string {
  const tpl = readFileSync(new URL(`${name}.md`, PROMPTS_DIR), "utf8");
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`prompt「${name}」缺少變數 ${key}`);
    return value;
  });
}

export type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** 讀取 Agent 產出的 JSON 檔並用 zod 驗證，錯誤訊息會直接回饋給 Agent */
export function readJsonFile<T extends z.ZodType>(path: string, schema: T): JsonResult<z.infer<T>> {
  if (!existsSync(path)) return { ok: false, error: `找不到 ${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, error: `${path} 不是合法的 JSON：${(e as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: `${path} 格式錯誤：\n${z.prettifyError(parsed.error)}` };
}

// 中日韓文字與全形符號在終端機占兩格
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 依終端機顯示寬度補空白，讓中英混排的欄位對齊 */
export function padDisplay(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}
