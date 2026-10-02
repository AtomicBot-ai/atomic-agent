import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { readErrnoCode } from "../errno-code.js";
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
 *
 * `causeCode` is the errno the transport left on the error's `cause`
 * chain (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`, …), present only
 * when there is one: a `status: null` with `reason: "fetch failed"` is
 * the same line for a link that is not running and one the network
 * cannot reach. Named as the trace's `error` row and the parking line
 * name it; a bare `code` reads as a provider's own error code, which is
 * what `code` means elsewhere in these lines. It needs no category gate,
 * unlike the trace's `error` row: only a failure `shouldAdvance` accepted
 * (`transport` or `model`) reaches this line, and a cancellation never
 * advances.
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
  const causeCode = readErrnoCode(error);
  logger.warn("provider failed; falling over to the next link", {
    from: advance.from,
    to: advance.to,
    ...(typeof status === "number" || status === null ? { status } : {}),
    ...(causeCode !== undefined ? { causeCode } : {}),
    reason: describeReason(error),
    ...(advance.sessionId ? { sessionId: advance.sessionId } : {}),
  });
}
