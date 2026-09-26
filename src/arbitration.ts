/** 兩家仲裁都要求修改時交回計畫修訂；整體執行次數由 maxAgentRuns 限制。 */
export function arbitrationDecision(
  verdicts: readonly ("approve" | "changes_requested" | "abstain")[],
  tieBreak: "proceed" | "stop",
): "proceed" | "revise" | "stop" | "invalid" {
  if (verdicts.includes("abstain")) return "invalid";
  const approvals = verdicts.filter((v) => v === "approve").length;
  if (approvals === verdicts.length) return "proceed";
  if (approvals > 0) return tieBreak;
  return verdicts.length === 2 ? "revise" : "stop";
}
