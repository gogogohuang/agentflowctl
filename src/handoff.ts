import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { flowDir, handoffPath, runDir } from "./paths.js";
import { HandoffLedger, HandoffResponse, HandoffSource, type HandoffIssue } from "./schemas.js";
import { readJsonFile, type JsonResult } from "./util.js";

const responsePath = (id: string) => join(flowDir(id), "handoff-response.json");
const receiptsDir = (id: string) => join(runDir(id), "handoff-receipts");
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const receiptPath = (id: string, key: string) => join(receiptsDir(id), `${keyHash(key)}.json`);
const Receipt = z.object({ callKey: z.string(), source: HandoffSource, response: HandoffResponse, role: z.enum(["writer", "reviewer"]) });

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readHandoff(id: string): HandoffLedger {
  const path = handoffPath(id);
  if (!existsSync(path)) return { version: 1, issues: [] };
  return HandoffLedger.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function openActions(ledger: HandoffLedger, target?: "plan" | "code"): HandoffIssue[] {
  return ledger.issues.filter((item) => item.kind === "action"
    && (item.status === "open" || item.status === "proposed_resolved")
    && (!target || item.targetStage === target));
}

export function reviewHandoffGate(ledger: HandoffLedger, target: "plan" | "code", verdict: "approve" | "changes_requested"): string | undefined {
  if (verdict !== "approve") return undefined;
  const pending = openActions(ledger, target);
  return pending.length ? `審查核准與未結交接事項矛盾：${pending.map((item) => item.id).join("、")}` : undefined;
}

export function previewHandoff(
  ledger: HandoffLedger,
  callKey: string,
  source: HandoffSource,
  response: HandoffResponse,
  role: "writer" | "reviewer",
): HandoffLedger {
  source = HandoffSource.parse(source);
  response = HandoffResponse.parse(response);
  if (source.callKey !== callKey) throw new Error("交接呼叫識別碼不一致");
  if (ledger.appliedCalls?.includes(callKey)) return ledger;
  const now = new Date().toISOString();
  const issues = ledger.issues.map((item) => ({ ...item }));
  for (const [index, item] of response.newIssues.entries()) {
    const id = createHash("sha256").update(`${callKey}:${index}`).digest("hex").slice(0, 16);
    if (issues.some((existing) => existing.id === id)) throw new Error(`交接事項 id 重複：${id}`);
    issues.push({ id, source, ...item, status: "open", updatedAt: now });
  }
  for (const disposition of response.dispositions) {
    const issue = issues.find((item) => item.id === disposition.id);
    if (!issue) throw new Error(`找不到交接事項：${disposition.id}`);
    if (issue.kind !== "action") throw new Error(`參考資訊不可結案：${disposition.id}`);
    if (issue.status === "resolved" || issue.status === "accepted") throw new Error(`交接事項已結案：${disposition.id}`);
    if (role === "writer" && disposition.status !== "proposed_resolved") throw new Error("作者只能提出已修正，不能自行結案");
    if (role === "reviewer" && disposition.status === "proposed_resolved") throw new Error("審查者須明確結案或接受風險");
    issue.status = disposition.status;
    issue.resolution = { agent: source.agent, reason: disposition.reason, evidence: disposition.evidence };
    issue.updatedAt = now;
  }
  return HandoffLedger.parse({ version: 1, issues, appliedCalls: [...(ledger.appliedCalls ?? []), callKey] });
}

export function mergeHandoff(
  id: string,
  callKey: string,
  source: HandoffSource,
  response: HandoffResponse,
  role: "writer" | "reviewer",
): HandoffLedger {
  const next = previewHandoff(readHandoff(id), callKey, source, response, role);
  writeAtomic(handoffPath(id), JSON.stringify(next, null, 2));
  return next;
}

/** 只把目前步驟需要處理的事項投影給 agent。 */
export function prepareHandoff(id: string, _callKey: string, target: "plan" | "code", blind: boolean): void {
  const items = readHandoff(id).issues.filter((item) => item.targetStage === target && (
    item.kind === "info" || item.status === "open" || item.status === "proposed_resolved"
  ));
  const lines = items.map((item) => {
    const source = blind ? "" : `\n來源：${item.source.stage}／${item.source.agent}`;
    const resolution = item.resolution ? `\n處理理由：${item.resolution.reason}\n處理證據：${item.resolution.evidence}` : "";
    return `## ${item.id}：${item.summary}\n證據：${item.evidence}\n狀態：${item.status}${resolution}${source}`;
  });
  mkdirSync(flowDir(id), { recursive: true });
  writeFileSync(join(flowDir(id), "handoff-context.md"), `# 待處理交接事項\n\n${lines.length ? lines.join("\n\n") : "目前沒有待處理事項。"}\n`);
  rmSync(responsePath(id), { force: true });
}

export function validateHandoffResponse(id: string): JsonResult<HandoffResponse> {
  return readJsonFile(responsePath(id), HandoffResponse);
}

/** 已通過原有關卡的回覆先記收據，再合併；中斷後可重播。 */
export function acceptHandoff(id: string, callKey: string, source: HandoffSource, response: HandoffResponse, role: "writer" | "reviewer"): void {
  const checked = Receipt.parse({ callKey, source, response, role });
  previewHandoff(readHandoff(id), callKey, source, response, role);
  const path = receiptPath(id, callKey);
  writeAtomic(path, JSON.stringify(checked));
  mergeHandoff(id, callKey, source, response, role);
  rmSync(path, { force: true });
}

export function recoverHandoff(id: string): void {
  const dir = receiptsDir(id);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, name);
    const receipt = Receipt.parse(JSON.parse(readFileSync(path, "utf8")));
    mergeHandoff(id, receipt.callKey, receipt.source, receipt.response, receipt.role);
    rmSync(path);
  }
}
