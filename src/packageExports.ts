// 測試提交後、叫實作者之前的靜態檢查：測試呼叫了「由套件匯入、但已安裝版本沒有」的函式（例如舊版 @testing-library/react 的 renderHook）。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./proc.js";
import { packageImportMap } from "./testGuard.js";

export interface MissingExport {
  spec: string;
  name: string;
}

/** 在 cwd 底下 require 每個套件，回報「載入成功但沒有這個匯出」的符號；載入失敗的套件一律略過，不誤判 */
const CHECK_SCRIPT = `
const { createRequire } = require("node:module");
const req = createRequire(process.cwd() + "/package.json");
const out = [];
for (const { spec, names } of JSON.parse(process.argv[1])) {
  let mod;
  try { mod = req(spec); } catch { continue; }
  if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) continue;
  for (const name of names) if (!(name in mod)) out.push({ spec, name });
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * 只檢查測試檔裡以函式呼叫（`名稱(`）的符號：型別匯入在執行期本來就不存在，不能當成缺失。
 * 套件載入不了、或子程序出錯時回傳空陣列（寧可放過，不要把好測試退回去）。
 */
export async function missingPackageExports(cwd: string, testFiles: string[]): Promise<MissingExport[]> {
  const wanted = new Map<string, Set<string>>();
  for (const file of testFiles) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const [spec, names] of packageImportMap(source)) {
      const called = [...names].filter((name) => new RegExp(`(?<![\\w.$])${name.replace(/\$/g, "\\$&")}\\s*\\(`).test(source));
      if (!called.length) continue;
      const set = wanted.get(spec) ?? new Set<string>();
      called.forEach((n) => set.add(n));
      wanted.set(spec, set);
    }
  }
  if (!wanted.size) return [];
  const payload = JSON.stringify([...wanted].map(([spec, names]) => ({ spec, names: [...names] })));
  try {
    const r = await exec(process.execPath, ["-e", CHECK_SCRIPT, payload], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0) return [];
    return JSON.parse(r.stdout) as MissingExport[];
  } catch {
    return [];
  }
}
