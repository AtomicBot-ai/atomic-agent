import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { describeReason } from "./describe-reason.js";

/** What `ProviderFallbackChain` logs through; a subset so tests can pass a spy. */
export type FallbackLogger = Pick<StructuredLogger, "warn">;

/**
 * One `warn` line per chain advance.
 *
 * The `provider_switched` notice is one-shot per partition and carries no
 * status, and when the next link fails too the turn reports that link's
 * error. Without this line the primary's own refusal — a 404 for a model
 * the service retired, a 401 for a dead key — was recorded nowhere, not
 * even at debug level, while the log filled with the fallback's
 * `fetch failed`.
 *
 * `reason` is the message collapsed and capped by `describeReason`, the
 * text the switch notice already shows in chat. The HTTP clients build
 * their messages from the status, the URL and the response body; request
 * headers never enter them, so no API key reaches this line.
 */
export function logFallbackAdvance(
  logger: FallbackLogger | undefined,
  advance: { from: string; to: string; error: unknown; sessionId: string },
): void {
  if (!logger) return;
  const { error } = advance;
  const status =
    error !== null && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  logger.warn("provider failed; falling over to the next link", {
    from: advance.from,
    to: advance.to,
    ...(typeof status === "number" || status === null ? { status } : {}),
    reason: describeReason(error),
    ...(advance.sessionId ? { sessionId: advance.sessionId } : {}),
  });
}
