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
  timeoutMs?: number;
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const processGroup = Boolean(opts.timeoutMs) && process.platform !== "win32";
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
      detached: processGroup,
    });
    // npm 安裝的 CLI 常再啟動原生執行檔；只殺啟動器會留下持續呼叫模型的程序。
    const killTree = () => {
      if (processGroup && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    };
    // 獨立程序群組收不到終端機的 Ctrl-C，要自己轉達；處理完再把訊號交回原本的處理方式。
    const onSignal = (signal: NodeJS.Signals) => {
      killTree();
      detachSignals();
      if (!process.listenerCount(signal)) process.kill(process.pid, signal);
    };
    const detachSignals = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("exit", killTree);
    };
    if (processGroup) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      process.once("exit", killTree);
    }
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killTree(); }, opts.timeoutMs) : undefined;
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
    child.on("error", (error) => { if (timer) clearTimeout(timer); detachSignals(); reject(error); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      detachSignals();
      if (opts.onStdoutLine && pending) opts.onStdoutLine(pending);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr: timedOut ? `${stderr}\n執行逾時` : stderr });
    });
    child.stdin.on("error", () => {}); // 子程序不讀 stdin 時忽略 EPIPE
    child.stdin.end(opts.input ?? "");
  });
}

/** 以系統 shell 執行一整行指令（用於 install、test、build 等專案指令） */
export const execShell = (command: string, opts: Omit<ExecOptions, "shell"> = {}) =>
  exec(command, [], { ...opts, shell: true });
