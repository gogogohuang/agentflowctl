import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { handoffPath } from "./paths.js";
import { HandoffLedger, HandoffResponse, HandoffSource, type HandoffIssue } from "./schemas.js";

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
  const path = handoffPath(id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
  return next;
}
