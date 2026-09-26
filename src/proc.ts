import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 寫入子程序的 stdin；一律會關閉 stdin，避免 CLI 一直等待輸入而卡住 */
  input?: string;
  /** 透過系統 shell 執行（macOS／Linux 為 sh，Windows 為 cmd） */
  shell?: boolean;
  onStdoutLine?: (line: string) => void;
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (!opts.onStdoutLine) return;
      pending += s;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => opts.onStdoutLine?.(line));
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (opts.onStdoutLine && pending) opts.onStdoutLine(pending);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {}); // 子程序不讀 stdin 時忽略 EPIPE
    child.stdin.end(opts.input ?? "");
  });
}

/** 以系統 shell 執行一整行指令（用於 install、test、build 等專案指令） */
export const execShell = (command: string, opts: Omit<ExecOptions, "shell"> = {}) =>
  exec(command, [], { ...opts, shell: true });
