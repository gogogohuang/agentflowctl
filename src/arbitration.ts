/** 仲裁沒有共識時，兩家先依裁決意見修訂計畫；重複仲裁仍受次數上限約束。 */
export function arbitrationDecision(
  verdicts: readonly ("approve" | "changes_requested" | "abstain")[],
  tieBreak: "proceed" | "stop",
  round: number,
  maxAttempts: number,
): "proceed" | "revise" | "stop" {
  const approvals = verdicts.filter((v) => v === "approve").length;
  if (approvals === verdicts.length) return "proceed";
  if (approvals > 0) return tieBreak;
  return verdicts.length === 2 && round < maxAttempts ? "revise" : "stop";
}
