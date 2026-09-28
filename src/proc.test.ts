import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { exec } from "./proc.js";

it.skipIf(process.platform === "win32")("逾時也停止 CLI 啟動的子程序，避免背景繼續呼叫模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-timeout-"));
  const marker = join(dir, "still-running");
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'仍在執行'),600)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setTimeout(()=>{},5000)`;
  try {
    expect((await exec(process.execPath, ["-e", parent], { timeoutMs: 200 })).code).toBe(124);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
