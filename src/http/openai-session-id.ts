import { createHash } from "node:crypto";

/**
 * Derive a stable chat session id from the first `system` + `user`
 * messages of an OpenAI chat request, mirroring hermes-agent's
 * `_derive_chat_session_id`. The digest is truncated to 16 hex chars
 * and prefixed with `api-` so these sessions are visually distinct
 * from random-UUID sessions created by the CLI / sidecar / TUI.
 *
 * Stability matters: the same client resending the same opening prompt
 * re-hits the same session, which both avoids leaking pseudo-sessions
 * into the store and lets the agent re-use its KV-cache slot.
 */
export function deriveChatSessionId(
  systemPrompt: string | null,
  firstUserMessage: string,
): string {
  const seed = `${systemPrompt ?? ""}\n${firstUserMessage}`;
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  return `api-${digest.slice(0, 16)}`;
}
