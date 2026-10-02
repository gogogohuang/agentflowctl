import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingPackageExports } from "./packageExports.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "afc-pkgexp-"));
  writeFileSync(join(dir, "package.json"), "{}");
  mkdirSync(join(dir, "node_modules", "old-lib"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "old-lib", "package.json"), JSON.stringify({ name: "old-lib", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "old-lib", "index.js"), "exports.render = () => 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("missingPackageExports", () => {
  it("呼叫了已安裝版本沒有的匯出就回報；有的、型別匯入、未呼叫的不回報", async () => {
    writeFileSync(join(dir, "a.test.ts"), [
      "import { render, renderHook, RenderResult } from 'old-lib'",
      "import { gone } from 'not-installed-lib'",
      "render(); renderHook(() => 1); gone();",
      "const x: RenderResult = 1",
    ].join("\n"));
    expect(await missingPackageExports(dir, ["a.test.ts"])).toEqual([{ spec: "old-lib", name: "renderHook" }]);
  });

  it("沒有套件匯入或檔案不存在時回傳空陣列", async () => {
    writeFileSync(join(dir, "b.test.ts"), "import { x } from './x'\nx()\n");
    expect(await missingPackageExports(dir, ["b.test.ts", "missing.test.ts"])).toEqual([]);
  });
});
