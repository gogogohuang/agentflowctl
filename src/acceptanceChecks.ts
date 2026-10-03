import type { AcceptanceItem } from "./schemas.js";

/** 驗收條件裡提到、但 verify 不會跑的指令 */
export interface UncoveredCommand {
  id: string;
  /** 條件文字裡的指令或腳本 */
  mention: string;
}

/** 常見的檢查工具名稱：條件提到它，verify 的指令裡就該出現同名工具 */
const TOOL_NAMES = ["shellcheck", "eslint", "tsc", "vitest", "pytest", "ruff", "mypy", "clippy", "golangci-lint"];
const TOOL_RE = new RegExp(`(?<![\\w./-])(${TOOL_NAMES.join("|")})(?![\\w-])`, "g");
/** `bash x.sh`、`sh x.sh`、`./x.sh`：以腳本檔名比對 */
const SCRIPT_RE = /(?<![\w./-])(?:(?:bash|sh|zsh)\s+)?((?:\.\/)?[\w./-]*[\w-]\.sh)(?![\w-])/g;

/**
 * 驗收條件要求跑某些檢查工具或腳本（例如「shellcheck、bash core/scripts/run-tests.sh 全數通過」），
 * 但 install／test／checks 都不會執行它時，列出對應的條件。
 * 這些證據只有 verify 能產生：agent 在沙箱內常跑不了，審查者又只認 .flow/verify.json，最後會卡在審查與修正的迴圈。
 * 只是比對名稱的啟發式，用來提醒，不擋關。
 */
export function uncoveredAcceptanceCommands(acceptance: readonly AcceptanceItem[], commands: readonly string[]): UncoveredCommand[] {
  const haystack = commands.join("\n");
  const found: UncoveredCommand[] = [];
  for (const item of acceptance) {
    const seen = new Set<string>();
    for (const match of item.description.matchAll(TOOL_RE)) {
      if (!seen.has(match[1]!) && !haystack.includes(match[1]!)) {
        seen.add(match[1]!);
        found.push({ id: item.id, mention: match[1]! });
      }
    }
    for (const match of item.description.matchAll(SCRIPT_RE)) {
      const script = match[1]!;
      const base = script.split("/").at(-1)!;
      if (!seen.has(script) && !haystack.includes(base)) {
        seen.add(script);
        found.push({ id: item.id, mention: script });
      }
    }
  }
  return found;
}

export function uncoveredMessage(found: readonly UncoveredCommand[]): string {
  return [
    "⚠️  驗收條件提到的指令不在 verify 會跑的 install／test／checks 裡：",
    ...found.map((f) => `   ${f.id}：${f.mention}`),
    "   agent 在沙箱內常跑不了這些，審查者又只認 .flow/verify.json，容易卡在審查與修正的迴圈；",
    "   請把它們加進 flow.config.json 的 checks（由程式在沙箱外執行）。",
  ].join("\n");
}
