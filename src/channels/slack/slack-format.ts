/**
 * Markdown → Slack mrkdwn, the few rewrites that matter.
 *
 * The agent writes ordinary markdown. Slack's `text` field speaks its
 * own dialect: `*bold*`, `_italic_`, `~strike~`, `<url|label>`, no
 * headings, and `&`, `<`, `>` must be escaped or Slack reads them as
 * control sequences (a literal `<!channel>` in a reply would ping the
 * whole channel). Code spans and fences pass through untouched apart
 * from that escaping, so commands and paths stay exact.
 */

/** Escape the three characters Slack treats as control syntax. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert one markdown reply to mrkdwn. */
export function markdownToSlack(markdown: string): string {
  // Odd indexes are code (fenced or inline), even indexes are prose.
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? escapeSlackText(part) : convertProse(part)))
    .join("");
}

function convertProse(text: string): string {
  // Links first, from the raw text, so the URL is not escaped twice.
  const links: string[] = [];
  const withPlaceholders = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      links.push(`<${url.replace(/>/g, "%3E")}|${escapeSlackText(label).replace(/\|/g, "¦")}>`);
      return `\u0000${links.length - 1}\u0000`;
    },
  );
  return escapeSlackText(withPlaceholders)
    .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? "");
}
