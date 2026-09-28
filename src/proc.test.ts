import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { exec } from "./proc.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 啟動一個子程序，它再啟動一個延遲寫入 marker 的孫程序，模擬 npm 啟動器包著原生 CLI */
const launcher = (marker: string, delayMs: number) => {
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'仍在執行'),${delayMs})`;
  return `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log('ready');setTimeout(()=>{},10000)`;
};

it.skipIf(process.platform === "win32")("逾時也停止 CLI 啟動的子程序，避免背景繼續呼叫模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-timeout-"));
  const marker = join(dir, "still-running");
  try {
    expect((await exec(process.execPath, ["-e", launcher(marker, 600)], { timeoutMs: 200 })).code).toBe(124);
    await sleep(750);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("Ctrl-C 中斷時也停止整個程序群組，並照常結束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-sigint-"));
  const marker = join(dir, "still-running");
  const script = join(dir, "probe.mts");
  const proc = join(dirname(fileURLToPath(import.meta.url)), "proc.ts");
  writeFileSync(script, `import { exec } from ${JSON.stringify(proc)};
await exec(process.execPath, ["-e", ${JSON.stringify(launcher(marker, 1000))}], { timeoutMs: 10000, onStdoutLine: (line) => console.log(line) });`);
  const tsx = createRequire(import.meta.url).resolve("tsx");
  try {
    const child = spawn(process.execPath, ["--import", tsx, script], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => { if (d.toString().includes("ready")) resolve(); });
      void exited.then(() => reject(new Error("探測腳本在子程序就緒前就結束")));
    });
    child.kill("SIGINT");
    expect(await exited).toBe("SIGINT");
    await sleep(1300);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
