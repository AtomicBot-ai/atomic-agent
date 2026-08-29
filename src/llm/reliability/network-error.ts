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
 * Messages undici/Node produce for a dead connection when no errno
 * survives the wrapping. `fetch failed` is the generic outer message;
 * the rest are the inner ones seen in the wild.
 */
const NETWORK_MESSAGES = [
  /^fetch failed$/i,
  /^terminated$/i,
  /socket hang up/i,
  /other side closed/i,
  /client network socket disconnected/i,
  /network socket disconnected/i,
];

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
    if (NETWORK_MESSAGES.some((re) => re.test(message.trim()))) return true;
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
