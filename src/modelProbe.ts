import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "./agents/index.js";
import { tryJson, type AgentEvent, type Invocation } from "./agents/types.js";
import { exec } from "./proc.js";
import type { AgentDef } from "./schemas.js";

export type ModelProbeResult =
  | { status: "ok"; resolvedModel?: string }
  | { status: "failed" | "unverifiable"; reason: string };

export function probeFailureReason(message: string): string {
  if (/unknown (option|argument|feature)|unexpected argument|unrecognized (option|argument)/i.test(message)) return `CLI 不支援模型探測參數，請更新 CLI：${message}`;
  if (/\b429\b|quota|rate.?limit|usage limit/i.test(message)) return `額度或速率限制：${message}`;
  if (/invalid model|model.*(not found|unknown|unavailable)|unknown model/i.test(message)) return `模型名稱無效或目前不可用：${message}`;
  if (/auth|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(message)) return `認證或權限失敗：${message}`;
  if (/network|connect|timed? out|dns|enotfound/i.test(message)) return `網路連線失敗：${message}`;
  return message;
}

/** 在獨立暫存目錄對指定模型送出最短請求；停用工具或限制成唯讀，工具事件一律不通過。 */
export async function probeModel(def: AgentDef, model: string, timeoutMs = 30000): Promise<ModelProbeResult> {
  const dir = mkdtempSync(join(tmpdir(), "agentflowctl-model-"));
  try {
    const adapter = ADAPTERS[def.adapter];
    let inv: Invocation;
    if (def.adapter === "command") {
      if (!def.modelProbe?.length || !def.modelProbe.some((arg) => arg.includes("{model}"))) {
        return { status: "unverifiable", reason: "command agent 缺少含 {model} 的 modelProbe" };
      }
      const [cmd, ...rest] = def.modelProbe;
      inv = { cmd: cmd!.replaceAll("{model}", model), args: rest.map((arg) => arg.replaceAll("{model}", model)) };
    } else {
      if (!adapter.invokeModelProbe) return { status: "unverifiable", reason: `${def.adapter} CLI 無法安全停用工具，因此不能驗證模型` };
      inv = adapter.invokeModelProbe(model, dir);
    }
    const events: AgentEvent[] = [];
    const result = await exec(inv.cmd, inv.args, {
      cwd: dir, env: inv.env, input: inv.input, timeoutMs,
      onStdoutLine: (line) => {
        if (def.adapter === "command") return;
        events.push(...adapter.parse(line));
        // 探測也拒絕尚未完成的工具；一般 log 仍在 item.completed 時顯示結果。
        if (def.adapter === "codex") {
          const raw = tryJson(line);
          const item = raw?.item as Record<string, unknown> | undefined;
          if (raw?.type === "item.started" && typeof item?.type === "string" && !["agent_message", "reasoning"].includes(item.type)) {
            events.push({ kind: "tool", name: item.type });
          }
        }
      },
    });
    if (result.code !== 0) return { status: "failed", reason: result.code === 124 ? "模型檢查逾時" : probeFailureReason(result.stderr.trim() || result.stdout.trim() || `結束碼 ${result.code}`) };
    if (def.adapter === "gemini" && /ignoring --admin-policy|policy file (error|warning)|error loading policy|invalid policy|failed to load.*polic/i.test(result.stderr)) {
      return { status: "failed", reason: `CLI 未完整載入模型探測的工具限制：${result.stderr.trim()}` };
    }
    // Codex 拒絕 apply_patch 時可能只寫 stderr，沒有 file_change 事件。
    if (def.adapter === "codex" && /patch rejected|tools::router.*error=/i.test(result.stderr)) {
      return { status: "failed", reason: `模型檢查期間嘗試呼叫工具：${result.stderr.trim()}` };
    }
    if (def.adapter === "command") {
      try {
        const data = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        if (data.requestedModel !== model || typeof data.resolvedModel !== "string" || !data.resolvedModel.trim()) {
          return { status: "failed", reason: "自訂探測命令回報的模型名稱不符" };
        }
        return { status: "ok", resolvedModel: data.resolvedModel };
      } catch {
        return { status: "failed", reason: "自訂探測命令未輸出有效 JSON" };
      }
    }
    if (events.some((e) => e.kind === "tool")) return { status: "failed", reason: "模型檢查期間出現工具呼叫，未通過無工具驗證" };
    const failed = events.find((e) => e.kind === "done" && !e.ok);
    if (failed?.kind === "done") return { status: "failed", reason: probeFailureReason(failed.summary ?? "CLI 回報失敗") };
    const done = events.filter((e) => e.kind === "done").at(-1);
    if (done?.kind !== "done") return { status: "failed", reason: "CLI 沒有回報完成" };
    if (!done.ok) return { status: "failed", reason: done.summary ?? "CLI 回報失敗" };
    if (!events.some((e) => e.kind === "text" && e.text.trim())) return { status: "failed", reason: "CLI 沒有回傳文字內容" };
    const resolved = events.find((e) => e.kind === "model");
    return { status: "ok", resolvedModel: resolved?.kind === "model" ? resolved.id : undefined };
  } catch (error) {
    return { status: "failed", reason: (error as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
