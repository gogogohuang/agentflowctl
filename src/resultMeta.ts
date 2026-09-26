import { z } from "zod";

/** Agent 回覆結尾的 <result> 中繼資料（格式定義在各 prompt 的 <reply_format>） */
export const ResultMeta = z.object({
  status: z.enum(["done", "blocked"]),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  concerns: z.string().default(""),
});
export type ResultMeta = z.infer<typeof ResultMeta>;

const tagText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

/** 取回覆中最後一個 <result> 區塊；沒有或格式不合時回傳 undefined，不影響關卡判斷 */
export function parseResultMeta(text: string): ResultMeta | undefined {
  const block = [...text.matchAll(/<result>([\s\S]*?)<\/result>/g)].at(-1)?.[1];
  if (block === undefined) return undefined;
  const files = tagText(block, "files_changed") ?? "";
  const parsed = ResultMeta.safeParse({
    status: tagText(block, "status"),
    summary: tagText(block, "summary"),
    filesChanged: [...files.matchAll(/<file>([\s\S]*?)<\/file>/g)].map((m) => m[1]!.trim()).filter(Boolean),
    concerns: tagText(block, "concerns"),
  });
  return parsed.success ? parsed.data : undefined;
}
