import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export function tail(s: string, max = 4000): string {
  return s.length <= max ? s : `…（前略）\n${s.slice(-max)}`;
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
