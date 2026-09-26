import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAgent, readRawConfig, removeAgent, setAgent, setCycle, writeRawConfig } from "./agentConfig.js";

describe("addAgent", () => {
  it("新增自訂 agent，保留其他欄位", () => {
    const next = addAgent({ tddSplit: false }, "claude-strong", { adapter: "claude", model: "opus" }).cfg;
    expect(next).toEqual({ tddSplit: false, agents: { "claude-strong": { adapter: "claude", model: "opus" } } });
  });

  it("command adapter 必須提供指令", () => {
    expect(() => addAgent({}, "aider", { adapter: "command" })).toThrow(/command/);
    expect(addAgent({}, "aider", { adapter: "command", command: ["aider", "{prompt}"] }).cfg.agents).toEqual({
      aider: { adapter: "command", command: ["aider", "{prompt}"] },
    });
  });

  it("名稱已存在或 adapter 不合法時報錯", () => {
    expect(() => addAgent({ agents: { x: { adapter: "codex" } } }, "x", { adapter: "claude" })).toThrow(/已存在/);
    expect(() => addAgent({}, "x", { adapter: "gpt" })).toThrow(/adapter/);
    expect(() => addAgent({}, "a b", { adapter: "claude" })).toThrow(/名稱/);
  });

  it("只有 command adapter 可以設定 command", () => {
    expect(() => addAgent({}, "x", { adapter: "claude", command: ["foo"] })).toThrow(/command/);
  });

  it("沒有內建 agent：claude、codex、gemini 也要自己新增", () => {
    expect(addAgent({}, "claude", { adapter: "claude" }).cfg).toEqual({ agents: { claude: { adapter: "claude" } } });
  });
});

describe("setAgent", () => {
  it("修改自訂 agent，只覆蓋有給的欄位", () => {
    const cfg = { agents: { x: { adapter: "codex", model: "a", extraArgs: ["--foo"] } } };
    expect(setAgent(cfg, "x", { model: "b" }).cfg.agents).toEqual({ x: { adapter: "codex", model: "b", extraArgs: ["--foo"] } });
    expect(setAgent(cfg, "x", { extraArgs: ["--bar"] }).cfg.agents).toEqual({ x: { adapter: "codex", model: "a", extraArgs: ["--bar"] } });
  });

  it("更換 adapter 時清掉舊 adapter 的欄位，除非這次有重新指定", () => {
    const cfg = { agents: { x: { adapter: "codex", model: "gpt", extraArgs: ["--foo"] } } };
    const r = setAgent(cfg, "x", { adapter: "claude" });
    expect(r.cfg.agents).toEqual({ x: { adapter: "claude" } });
    expect(r.changes.join("\n")).toMatch(/model/);
    expect(setAgent(cfg, "x", { adapter: "claude", model: "opus" }).cfg.agents).toEqual({ x: { adapter: "claude", model: "opus" } });
    const cmd = { agents: { a: { adapter: "command", command: ["aider"] } } };
    expect(setAgent(cmd, "a", { adapter: "gemini" }).cfg.agents).toEqual({ a: { adapter: "gemini" } });
    expect(() => setAgent({ agents: { x: { adapter: "codex" } } }, "x", { adapter: "command" })).toThrow(/command/);
  });

  it("未定義的 agent 或沒有要改的欄位時報錯", () => {
    expect(() => setAgent({}, "nope", { model: "x" })).toThrow(/未定義/);
    expect(() => setAgent({}, "claude", { model: "x" })).toThrow(/未定義/);
    expect(() => setAgent({ agents: { claude: { adapter: "claude" } } }, "claude", {})).toThrow(/沒有要修改/);
  });
});

describe("removeAgent", () => {
  it("刪除自訂 agent", () => {
    expect(removeAgent({ agents: { x: { adapter: "codex" } } }, "x").cfg).toEqual({ agents: {} });
  });

  it("一併從輪替順序移除", () => {
    const r = removeAgent({ cycle: ["x", "claude"], agents: { x: { adapter: "codex" }, claude: { adapter: "claude" } } }, "x");
    expect(r.cfg).toEqual({ cycle: ["claude"], agents: { claude: { adapter: "claude" } } });
    expect(r.changes.join("\n")).toMatch(/輪替/);
  });

  it("輪替順序因此變空時刪掉 cycle，改回自動偵測", () => {
    const r = removeAgent({ cycle: ["x"], agents: { x: { adapter: "codex" } } }, "x");
    expect(r.cfg).toEqual({ agents: {} });
    expect(r.changes.join("\n")).toMatch(/自動偵測/);
  });

  it("未定義的 agent 報錯", () => {
    expect(() => removeAgent({}, "nope")).toThrow(/未定義/);
    expect(() => removeAgent({}, "gemini")).toThrow(/未定義/);
  });
});

describe("setCycle", () => {
  it("設定輪替順序", () => {
    const cfg = { agents: { x: { adapter: "codex" }, claude: { adapter: "claude" } } };
    expect(setCycle(cfg, ["x", "claude"]).cfg.cycle).toEqual(["x", "claude"]);
  });

  it("空的、重複或未定義的名稱都報錯", () => {
    expect(() => setCycle({}, [])).toThrow(/至少/);
    expect(() => setCycle({}, ["claude", "claude"])).toThrow(/重複/);
    expect(() => setCycle({ agents: { claude: { adapter: "claude" } } }, ["claude", "nope"])).toThrow(/未定義/);
    expect(() => setCycle({}, ["claude", "gemini"])).toThrow(/未定義/);
  });
});

describe("讀寫 flow.config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-cfg-"));
  const path = join(dir, "flow.config.json");

  it("檔案不存在時視為空設定，寫入時保留未知欄位", () => {
    expect(readRawConfig(path)).toEqual({});
    writeRawConfig(path, { custom: 1, cycle: ["claude"] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ custom: 1, cycle: ["claude"] });
  });

  it("不合法的設定不會寫入", () => {
    writeFileSync(path, "{}");
    expect(() => writeRawConfig(path, { tddSplit: "yes" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{}");
  });
});
