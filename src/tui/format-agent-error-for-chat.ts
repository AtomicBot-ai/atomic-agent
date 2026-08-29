import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";

const MAX_CHARS = 480;

/**
 * Where the failed turn was pointed, so a transport failure can say what
 * to actually do about it. The CLI has printed
 * `formatLlamaUnreachableHint` for years; the TUI dropped the same
 * failure as a bare `fetch failed` — this closes that gap. Gated on the
 * active provider being local because for a cloud provider the llama
 * hint would be advice about the wrong server.
 */
export interface LocalProviderErrorContext {
  activeProviderIsLocal: boolean;
  llamaUrl: string;
}

/**
 * Compact, chat-safe agent failure text (strips HTML walls from bad URLs).
 */
export function formatAgentErrorForChat(
  category: string,
  message: string,
  local?: LocalProviderErrorContext,
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
  const base = `Turn failed [${category}]: ${body}`;
  if (category === "transport" && local?.activeProviderIsLocal) {
    return `${base}\n${formatLlamaUnreachableHint(local.llamaUrl)}`;
  }
  return base;
}
