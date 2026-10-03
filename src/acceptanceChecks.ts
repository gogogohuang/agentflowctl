import type { AcceptanceItem } from "./schemas.js";

/** 驗收條件裡提到、但 verify 不會跑的指令 */
export interface UncoveredCommand {
  id: string;
  /** 條件文字裡的指令或腳本 */
  mention: string;
}

/** 常見的檢查工具名稱：條件提到它，verify 的指令裡就該出現同名工具 */
const TOOL_NAMES = [
  "shellcheck", "shfmt", "eslint", "biome", "prettier", "stylelint", "markdownlint", "tsc", "vitest", "jest", "mocha",
  "pytest", "ruff", "flake8", "pylint", "mypy", "pyright", "black", "clippy", "rustfmt", "golangci-lint", "staticcheck",
  "rubocop", "rspec", "phpunit", "phpstan", "ktlint", "detekt", "swiftlint", "hadolint", "yamllint", "actionlint",
];
const TOOL_RE = new RegExp(`(?<![\\w./-])(${TOOL_NAMES.join("|")})(?![\\w-])`, "g");
/** 腳本：`.sh` 單獨出現就算；其他語言要有直譯器前綴（`python x.py`、`node x.js`）或 `./`，避免把「修改 src/foo.ts」當成要執行的指令 */
const SCRIPT_RE = /(?<![\w./-])(?:(?:bash|sh|zsh|python3?|ruby|perl|node|tsx|deno|bun|pwsh)\s+(?:-\S+\s+)*|(?=\.\/))?((?:\.\/)?[\w./-]*[\w-]\.(?:sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts|ps1))(?![\w-])/g;

/** 指令字串裡是否含這個詞（前後不是字母數字或連字號：`tsc` 不算出現在 `tsconfig`，`run.sh` 不算出現在 `xrun.sh`） */
function mentions(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(haystack);
}

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
      if (!seen.has(match[1]!) && !mentions(haystack, match[1]!)) {
        seen.add(match[1]!);
        found.push({ id: item.id, mention: match[1]! });
      }
    }
    for (const match of item.description.matchAll(SCRIPT_RE)) {
      const script = match[1]!;
      if (!/\.(?:sh|bash|zsh)$/.test(script) && match[0] === script && !script.startsWith("./")) continue;
      const base = script.split("/").at(-1)!;
      if (!seen.has(script) && !mentions(haystack, base)) {
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
