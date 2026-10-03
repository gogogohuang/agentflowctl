/** agent 提供的文字必須跳脫，才不會打斷意見的 XML 邊界。 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
}

export function reviewIssue(criterion: string, status: string, note: string): string {
  return `<issue criterion="${escapeXml(criterion)}" status="${escapeXml(status)}">${escapeXml(note)}</issue>`;
}

/** 審查者提出、不屬於任何驗收條件的額外發現：和 <issue> 分開標示，修正者要先確認證據屬實、確實是缺陷才處理 */
export function extraFinding(status: string, note: string, evidence: string): string {
  return `<extra_finding status="${escapeXml(status)}" evidence="${escapeXml(evidence)}">${escapeXml(note)}</extra_finding>`;
}

export function opinion(author: string, issues: string[], verdict?: string): string {
  const name = escapeXml(author);
  const outcome = verdict ? ` verdict="${escapeXml(verdict)}"` : "";
  return `<opinion author="${name}"${outcome}>\n${issues.join("\n")}\n</opinion>`;
}
