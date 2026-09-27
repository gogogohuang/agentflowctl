import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "./agents/index.js";
import { probeFailureReason, probeModel } from "./modelProbe.js";

describe("模型即時探測", () => {
  it("專用探測參數不沿用一般執行的工具權限", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-probe-args-"));
    const claude = ADAPTERS.claude.invokeModelProbe?.("model-x", dir);
    expect(claude?.args).toContain("--tools");
    expect(claude?.args).not.toContain("acceptEdits");
    const gemini = ADAPTERS.gemini.invokeModelProbe?.("model-x", dir);
    expect(gemini?.args).toContain("--policy");
    expect(gemini?.args).not.toContain("yolo");
    expect(ADAPTERS.codex.invokeModelProbe).toBeUndefined();
  });

  it("command 只接受與輸入名稱一致的結構化回報", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentflowctl-probe-"));
    const script = join(dir, "probe.cjs");
    writeFileSync(script, "console.log(JSON.stringify({requestedModel:process.argv[2],resolvedModel:'actual-id'}))");
    const def = { adapter: "command" as const, extraArgs: [], command: ["custom", "--model", "{model}"], modelProbe: [process.execPath, script, "{model}"] };
    expect(await probeModel(def, "alias", 1000)).toMatchObject({ status: "ok", resolvedModel: "actual-id" });
    writeFileSync(script, "console.log(JSON.stringify({requestedModel:'other',resolvedModel:'actual-id'}))");
    expect((await probeModel(def, "alias", 1000)).status).toBe("failed");
  });

  it("command 探測逾時與 Codex 無工具能力不足時拒絕驗證", async () => {
    const command = { adapter: "command" as const, extraArgs: [], command: ["custom", "{model}"], modelProbe: [process.execPath, "-e", "setTimeout(()=>{},10000)", "{model}"] };
    expect((await probeModel(command, "alias", 30)).status).toBe("failed");
    expect((await probeModel({ adapter: "codex", extraArgs: [] }, "model-x", 100)).status).toBe("unverifiable");
  });

  it("會發 done 事件的 CLI 沒回報完成時不算通過", async () => {
    const bin = mkdtempSync(join(tmpdir(), "agentflowctl-probe-bin-"));
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
    const result = JSON.stringify({ type: "result", is_error: false, result: "OK" });
    const fake = join(bin, "claude");
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      writeFileSync(fake, `#!/bin/sh\necho '${text}'\n`, { mode: 0o755 });
      expect(await probeModel({ adapter: "claude", extraArgs: [] }, "model-x", 5000)).toMatchObject({ status: "failed" });
      writeFileSync(fake, `#!/bin/sh\necho '${text}'\necho '${result}'\n`, { mode: 0o755 });
      expect((await probeModel({ adapter: "claude", extraArgs: [] }, "model-x", 5000)).status).toBe("ok");
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("把常見失敗歸類成使用者看得懂的原因", () => {
    expect(probeFailureReason("HTTP 429 quota exceeded")).toContain("額度");
    expect(probeFailureReason("invalid model id")).toContain("模型名稱");
    expect(probeFailureReason("authentication failed")).toContain("認證");
  });
});
