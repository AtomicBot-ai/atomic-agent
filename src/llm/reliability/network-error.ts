/**
 * Recognition of raw network failures that reach the runtime *untyped*.
 *
 * `LlamaServerClient` and the OpenAI HTTP client both wrap their own
 * failures into `LlamaServerError` / `OpenAiHttpError`, so the classifier
 * can read a status off them. Everything else that talks HTTP — MCP
 * streamable-http transports, embedding calls, vendor SDKs that bring
 * their own `fetch` — throws whatever `undici` threw: a bare
 * `TypeError: fetch failed` whose `cause` carries the real errno, or an
 * `Error: terminated` when the socket dies mid-body.
 *
 * Without this recognition those land in `classifyFailure`'s catch-all
 * and are filed as `tool` failures, which is wrong twice over: the user
 * is told "Turn failed [tool]" for someone else's dead socket, and
 * `shouldAdvance` refuses to fall over to the next provider because a
 * tool failure is by definition our own bug, not the provider's.
 */

/**
 * Connection-level errno codes. Deliberately excludes `EPIPE` / `EIO`:
 * those are overwhelmingly stdio (a closed host pipe, a vanished tty)
 * rather than an upstream provider, and misreading one as `transport`
 * would send the fallback chain hunting for a different provider over a
 * broken *local* stream.
 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "ETIMEDOUT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** undici stamps its own failures with `UND_ERR_*` (`UND_ERR_SOCKET`, …). */
const UNDICI_CODE_PREFIX = "UND_ERR_";

/**
 * The subset of the messages below that can only be produced by a socket
 * that was *established and carrying a request* when it died — i.e. the
 * cases where it is true to tell an operator that a reply was cut off.
 *
 * Membership is argued per pattern, because the whole value of this list
 * is that everything in it supports that claim:
 *
 * - `/^terminated$/i` — undici's word for the socket dying mid-body,
 *   after the response has begun. The reported case (#339).
 * - `/socket hang up/i` — Node core, emitted when the peer closes a
 *   socket that already carries our request and no complete response has
 *   arrived. The request was in flight by construction.
 * - `/other side closed/i` — undici, the peer closing a connection we
 *   were already using.
 *
 * Deliberately excluded, though both are network failures and both stay
 * in `NETWORK_MESSAGES` below:
 *
 * - `/^fetch failed$/i` — undici's outer catch-all, which it *also*
 *   throws for a connection that never opened. Verified on Node 22.22.2:
 *   `ENOTFOUND` on an unresolvable host and `ECONNREFUSED` on a closed
 *   port both surface as exactly `fetch failed`, the errno surviving only
 *   on `cause`. Nothing was in flight, so "the reply was cut off" is
 *   simply false for it.
 * - `/network socket disconnected/i` — the TLS variant ("… before secure
 *   TLS connection was established") names a handshake that never
 *   completed, so no request was ever sent.
 */
const MID_STREAM_DROP_MESSAGES = [
  /^terminated$/i,
  /socket hang up/i,
  /other side closed/i,
];

/**
 * Messages undici/Node produce for a dead connection when no errno
 * survives the wrapping. `fetch failed` is the generic outer message;
 * the rest are the inner ones seen in the wild.
 *
 * `/client network socket disconnected/i` used to sit here next to the
 * unanchored `/network socket disconnected/i`; it is a strict subset of
 * it (every string matching the first matches the second) and matched
 * nothing extra, so it is gone. No behaviour change.
 */
const NETWORK_MESSAGES = [
  /^fetch failed$/i,
  /network socket disconnected/i,
  ...MID_STREAM_DROP_MESSAGES,
];

/**
 * True when `message` is one of the stock "the connection is gone"
 * strings above. Shared with `isNetworkError`'s message arm rather than
 * copied, so the two can never drift apart: the classifier and any
 * message-only consumer recognise exactly the same vocabulary.
 *
 * This is the CLASSIFIER's key — deliberately broad, because for
 * `shouldAdvance` / fallover a connection that never opened and one that
 * died mid-body are the same verdict. Do not use it to say anything to a
 * user about what happened to their reply; use
 * `looksLikeMidStreamDrop` for that.
 */
export function looksLikeDroppedConnection(message: string): boolean {
  const trimmed = message.trim();
  return NETWORK_MESSAGES.some((re) => re.test(trimmed));
}

/**
 * True when `message` names a connection that broke *while a reply was
 * in flight* — the strict subset of `looksLikeDroppedConnection` above
 * that justifies telling an operator their reply was cut off.
 *
 * Same file, same vocabulary, one list feeding the other, so a new
 * pattern has to be classified as one or the other rather than silently
 * joining both.
 */
export function looksLikeMidStreamDrop(message: string): boolean {
  const trimmed = message.trim();
  return MID_STREAM_DROP_MESSAGES.some((re) => re.test(trimmed));
}

/** Depth cap on the `cause` walk — a chain longer than this is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The errno-style code carried by `err` or anything in its `cause`
 * chain, when that code names a connection-level failure. Returns
 * `undefined` for everything else — including codes we deliberately do
 * not treat as network failures.
 */
export function readNetworkErrorCode(err: unknown): string | undefined {
  for (const link of causeChain(err)) {
    const code = (link as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    if (NETWORK_ERROR_CODES.has(code) || code.startsWith(UNDICI_CODE_PREFIX)) {
      return code;
    }
  }
  return undefined;
}

/**
 * True when `err` is a raw transport failure rather than a defect in our
 * own code: an errno from the connection layer anywhere in the cause
 * chain, or one of undici's stock "the socket is gone" messages.
 *
 * Callers must check for cancellation FIRST — an aborted request can
 * surface as `ECONNRESET`, and a user pressing Esc is not a network
 * failure.
 */
export function isNetworkError(err: unknown): boolean {
  if (readNetworkErrorCode(err) !== undefined) return true;
  for (const link of causeChain(err)) {
    const message = (link as { message?: unknown }).message;
    if (typeof message !== "string") continue;
    if (looksLikeDroppedConnection(message)) return true;
  }
  return false;
}

/** `err` followed by its `cause` links, bounded and cycle-safe. */
function* causeChain(err: unknown): Generator<object> {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return;
    yield current;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return;
    current = next;
  }
}
