import { describe, expect, it } from "vitest";
import { uncoveredAcceptanceCommands, uncoveredMessage } from "./acceptanceChecks.js";

const ac = (id: string, description: string) => ({ id, description });

describe("驗收條件提到、verify 不會跑的指令", () => {
  const AC20 = ac("AC-20", "執行同步腳本後 codex/ 產生檔與來源同步，npm test、shellcheck、bash core/scripts/run-tests.sh 全數通過");

  it("只跑 npm test：shellcheck 與 run-tests.sh 都被列出", () => {
    const found = uncoveredAcceptanceCommands([AC20], ["npm install", "npm test"]);
    expect(found).toEqual([
      { id: "AC-20", mention: "shellcheck" },
      { id: "AC-20", mention: "core/scripts/run-tests.sh" },
    ]);
  });

  it("checks 已含這些指令就不列", () => {
    const cmds = ["npm test", "shellcheck -S warning core/scripts/*.sh", "bash core/scripts/run-tests.sh"];
    expect(uncoveredAcceptanceCommands([AC20], cmds)).toEqual([]);
  });

  it("腳本以檔名比對，路徑寫法不同也算涵蓋", () => {
    expect(uncoveredAcceptanceCommands([ac("AC-1", "執行 ./scripts/check.sh 通過")], ["sh scripts/check.sh"])).toEqual([]);
  });

  it("不是獨立單字的不算（eslint-plugin、tsconfig.json）", () => {
    expect(uncoveredAcceptanceCommands([ac("AC-1", "新增 eslint-plugin-foo 並更新 tsconfig.json")], ["npm test"])).toEqual([]);
  });

  it("tsc 不會因為指令含 tsconfig 就算涵蓋；腳本名要整詞符合", () => {
    expect(uncoveredAcceptanceCommands([ac("AC-1", "tsc 通過")], ["vitest --config tsconfig.json"])).toEqual([{ id: "AC-1", mention: "tsc" }]);
    expect(uncoveredAcceptanceCommands([ac("AC-2", "執行 scripts/run.sh")], ["bash scripts/xrun.sh"])).toEqual([{ id: "AC-2", mention: "scripts/run.sh" }]);
  });

  it("不限 shell：其他語言的腳本與工具也比對", () => {
    const found = uncoveredAcceptanceCommands([ac("AC-1", "python tools/check.py 與 rubocop 通過")], ["pytest"]);
    expect(found).toEqual([
      { id: "AC-1", mention: "rubocop" },
      { id: "AC-1", mention: "tools/check.py" },
    ]);
  });

  it("同一條件重複提到同一指令只列一次；訊息列出條件與指令", () => {
    const found = uncoveredAcceptanceCommands([ac("AC-3", "shellcheck 通過，且 shellcheck 沒有警告")], []);
    expect(found).toHaveLength(1);
    expect(uncoveredMessage(found)).toContain("AC-3：shellcheck");
    expect(uncoveredMessage(found)).toContain("checks");
  });
});
