const MAX_CHARS = 480;

/**
 * Compact, chat-safe agent failure text (strips HTML walls from bad URLs).
 */
export function formatAgentErrorForChat(
  category: string,
  message: string,
): string {
  let body = message.trim().replace(/\s+/g, " ");
  if (
    body.includes("<!DOCTYPE") ||
    body.includes("<html") ||
    body.length > 800
  ) {
    const statusMatch = /\b(\d{3})\b/.exec(body);
    const status = statusMatch?.[1];
    body =
      status != null
        ? `upstream HTTP ${status} (wrong API URL or provider config)`
        : "upstream returned HTML instead of JSON (check API URL and provider)";
  }
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}…`;
  }
  return `Turn failed [${category}]: ${body}`;
}
