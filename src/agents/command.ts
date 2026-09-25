import type { Adapter } from "./types.js";

/**
 * 任何其他 agent CLI（aider、opencode、自己寫的腳本……）。
 * 在設定裡提供 command 陣列，`{prompt}` 會被替換成 prompt；沒有 `{prompt}` 時改由 stdin 傳入。
 * 不解析輸出：以 exit code 判斷成功，stdout 最後一段當作摘要。
 */
export const command: Adapter = {
  probe: (cmd) => ({ cmd: cmd?.[0] ?? "false", args: ["--version"] }),
  invoke(o) {
    const [cmd, ...rest] = o.command ?? [];
    if (!cmd) throw new Error("command adapter 需要設定 command 陣列");
    const hasPlaceholder = rest.some((a) => a.includes("{prompt}"));
    return {
      cmd,
      args: [...rest.map((a) => a.replaceAll("{prompt}", o.prompt)), ...o.extraArgs],
      input: hasPlaceholder ? undefined : o.prompt,
    };
  },
  parse: () => [],
};
