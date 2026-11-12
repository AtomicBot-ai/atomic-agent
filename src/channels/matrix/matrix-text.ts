/**
 * Inbound text clean-up for Matrix: drop the quoted reply fallback and
 * a leading "@bot:" address, and build the `[from]` identity line.
 */

/**
 * A reply carries the quoted original as `> ` lines and a blank line
 * before the new text (the spec's reply fallback). The agent should see
 * the request, not the quote; the quote may also be someone else's
 * words, which must not reach the prompt as if the owner wrote them.
 */
export function stripReplyFallback(body: string, content: Record<string, unknown>): string {
  const relates = content["m.relates_to"] as { "m.in_reply_to"?: unknown } | undefined;
  if (relates?.["m.in_reply_to"] === undefined) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").startsWith(">")) i++;
  if (i === 0) return body;
  if (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return lines.slice(i).join("\n");
}

/**
 * Remove a leading address to the bot: `@bot:server: hi`, `bot: hi`
 * (Element's mention pill renders the display name, which is usually
 * the localpart). Only the leading address goes; a mention mid-sentence
 * is content.
 */
export function stripBotMention(text: string, botUserId: string): string {
  const localpart = botUserId.replace(/^@/, "").split(":")[0] ?? "";
  for (const prefix of [botUserId, localpart]) {
    if (prefix.length === 0) continue;
    const re = new RegExp(`^\\s*@?${escapeRegExp(prefix.replace(/^@/, ""))}\\s*[:,]\\s*`, "i");
    if (re.test(text)) return text.replace(re, "");
  }
  return text;
}

/**
 * `[from] platform=matrix user=@ada:example.org chat=!room:example.org`.
 * The shared `formatSenderLine` keeps only `[A-Za-z0-9_-]` in ids,
 * which would turn every mxid into an unreadable run of letters, so
 * Matrix ids get their own allowlist: the characters an mxid or room id
 * can contain, never a space or a quote, so a value cannot leave its field.
 */
export function matrixSenderLine(userId: string, roomId: string): string {
  const parts = ["[from]", "platform=matrix"];
  const user = sanitizeMatrixId(userId);
  const room = sanitizeMatrixId(roomId);
  if (user) parts.push(`user=${user}`);
  if (room) parts.push(`chat=${room}`);
  return parts.join(" ");
}

export function sanitizeMatrixId(raw: string): string | undefined {
  const cleaned = raw.replace(/[^A-Za-z0-9._=:@!#/+-]/g, "").slice(0, 128);
  return cleaned.length > 0 ? cleaned : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
