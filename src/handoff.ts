import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { flowDir, handoffPath, sharedRunDir } from "./paths.js";
import { HandoffLedger, HandoffResponse, HandoffSource, type HandoffIssue } from "./schemas.js";
import { readJsonFile, type JsonResult } from "./util.js";

/** agent 寫交接回覆的位置；平行審查者用自己臨時 worktree 的 .flow/ */
export const responsePath = (id: string, flow = flowDir(id)) => join(flow, "handoff-response.json");
const receiptsDir = (id: string) => join(sharedRunDir(id), "handoff-receipts");
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

const SIMILARITY_THRESHOLD = 0.15;
const ANCHOR_RE = /[\w./@-]+\.[A-Za-z]{1,5}\b|AC-\d+/g;
const normalizeText = (text: string) => text.toLowerCase().replace(/[\s，。、：；（）()「」『』,.:;"'`]/g, "");

/** 路徑與條件編號另外當錨點比對，算相似度時先拿掉，免得長路徑讓不同問題看起來很像 */
function bigrams(text: string): Set<string> {
  const flat = normalizeText(text.replace(ANCHOR_RE, ""));
  return new Set(Array.from({ length: Math.max(0, flat.length - 1) }, (_, i) => flat.slice(i, i + 2)));
}

/** 證據與摘要裡提到的檔案路徑與驗收條件編號；兩筆事項指向同一處才可能是同一件事 */
function anchors(text: string): Set<string> {
  return new Set(text.match(ANCHOR_RE) ?? []);
}

/**
 * 兩筆事項是否在講同一件事：種類與目標階段相同，且摘要完全相同，
 * 或指向同一個檔案／驗收條件、去掉路徑後的文字（摘要加證據）字元雙連詞相似度夠高。
 * 只靠相似度會把「同一檔案的不同問題」併在一起，所以一定要有共同的錨點。
 */
export function isDuplicateIssue(
  a: Pick<HandoffIssue, "kind" | "targetStage" | "summary" | "evidence">,
  b: Pick<HandoffIssue, "kind" | "targetStage" | "summary" | "evidence">,
): boolean {
  if (a.kind !== b.kind || a.targetStage !== b.targetStage) return false;
  if (normalizeText(a.summary) === normalizeText(b.summary)) return true;
  const textA = `${a.summary} ${a.evidence}`;
  const textB = `${b.summary} ${b.evidence}`;
  const anchorsB = anchors(textB);
  if (![...anchors(textA)].some((anchor) => anchorsB.has(anchor))) return false;
  const setA = bigrams(textA);
  const setB = bigrams(textB);
  const shared = [...setA].filter((gram) => setB.has(gram)).length;
  return shared / (setA.size + setB.size - shared) >= SIMILARITY_THRESHOLD;
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
    // 同一件事被不同輪重複回報時，併進還沒處理的那一筆，不另開新事項
    const same = issues.find((existing) => existing.status === "open" && isDuplicateIssue(existing, item));
    if (same) {
      same.repeats = (same.repeats ?? 0) + 1;
      same.updatedAt = now;
      continue;
    }
    issues.push({ id, source, ...item, status: "open", updatedAt: now });
  }
  for (const disposition of response.dispositions) {
    const issue = issues.find((item) => item.id === disposition.id);
    if (!issue) throw new Error(`找不到交接事項：${disposition.id}`);
    // 參考資訊沒有結案流程，已結案的事項也不需再處置：略過即可，不讓整個步驟因此重試
    if (issue.kind !== "action" || issue.status === "resolved" || issue.status === "accepted") continue;
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
export function prepareHandoff(id: string, _callKey: string, target: "plan" | "code", blind: boolean, flow = flowDir(id)): void {
  const items = readHandoff(id).issues.filter((item) => item.targetStage === target && (
    item.kind === "info" || item.status === "open" || item.status === "proposed_resolved"
  ));
  const render = (item: (typeof items)[number]) => {
    const source = blind ? "" : `\n來源：${item.source.stage}／${item.source.agent}`;
    const resolution = item.resolution ? `\n處理理由：${item.resolution.reason}\n處理證據：${item.resolution.evidence}` : "";
    const status = item.kind === "action" ? `\n狀態：${item.status}` : "";
    const repeats = item.repeats ? `\n已重複回報：${item.repeats} 次` : "";
    return `### ${item.id}：${item.summary}\n類型：${item.kind}\n證據：${item.evidence}${status}${repeats}${resolution}${source}`;
  };
  const actions = items.filter((item) => item.kind === "action").map(render);
  const infos = items.filter((item) => item.kind !== "action").map(render);
  const sections = [
    actions.length ? `## 待處理事項（action，可在 dispositions 處置）\n\n${actions.join("\n\n")}` : "",
    infos.length ? `## 參考資訊（info，只供參考，不要放進 dispositions）\n\n${infos.join("\n\n")}` : "",
  ].filter(Boolean);
  mkdirSync(flow, { recursive: true });
  writeFileSync(join(flow, "handoff-context.md"), `# 待處理交接事項\n\n${sections.length ? sections.join("\n\n") : "目前沒有待處理事項。"}\n`);
  rmSync(responsePath(id, flow), { force: true });
}

export function validateHandoffResponse(id: string, flow = flowDir(id)): JsonResult<HandoffResponse> {
  return readJsonFile(responsePath(id, flow), HandoffResponse);
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
