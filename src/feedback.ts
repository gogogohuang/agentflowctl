/** agent 提供的文字必須跳脫，才不會打斷意見的 XML 邊界。 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]!);
}

export function reviewIssue(criterion: string, status: string, note: string): string {
  return `<issue criterion="${escapeXml(criterion)}" status="${escapeXml(status)}">${escapeXml(note)}</issue>`;
}

export function opinion(author: string, issues: string[], verdict?: string): string {
  const name = escapeXml(author);
  const outcome = verdict ? ` verdict="${escapeXml(verdict)}"` : "";
  return `<opinion author="${name}"${outcome}>\n${issues.join("\n")}\n</opinion>`;
}
