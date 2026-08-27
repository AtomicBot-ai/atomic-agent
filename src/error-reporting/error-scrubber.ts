/**
 * Strict allowlist scrubber. The product guarantee is that **no
 * user-originated data** ever leaves the machine in an error report, so
 * this module builds events from a fixed set of safe fields rather than
 * trying to redact the raw error text (a blacklist approach that leaks:
 * error messages routinely interpolate file paths, URLs, prompt output,
 * or JSON snippets of user content).
 */

/** Neutral, transport-agnostic shape of a scrubbed error report. */
export interface ScrubbedErrorEvent {
  /** Error class name, e.g. `TransportError` / `TypeError`. */
  errorType: string;
  /**
   * Class name of `err.cause`, when the top-level error is a generic
   * wrapper (e.g. `ToolExecutionError("unknown", ...)` built by
   * `toLlmFailure`'s catch-all branch). A class name is not
   * user-originated data — same safety bar as `errorType` — but it
   * distinguishes a `TypeError` from a `SyntaxError` etc. that would
   * otherwise all collapse into the same wrapper type.
   */
  causeType?: string;
  /** LLM failure taxonomy, when the error carries one. */
  category?: string;
  /** Where the error was captured (`uncaughtException`, `llm_failure`, …). */
  source: string;
  /** Error message — present ONLY for allowlisted static-message errors. */
  message?: string;
  /** Safe scalar HTTP status, when present on the error. */
  httpStatus?: number;
  /** Safe errno-style code (e.g. `ECONNREFUSED`), when present. */
  code?: string;
  /**
   * `ModelError.reason` when present. Restricted to the fixed 3-value
   * enum (`truncated | empty | no_stop`) — never freeform.
   */
  reason?: string;
  /**
   * `ToolExecutionError.tool` when present. Restricted to a bounded
   * identifier shape (registry tool names such as `os.fs.read`) — never
   * freeform text, since a hallucinated tool name could in theory echo
   * model output derived from the user's conversation.
   */
  tool?: string;
  /**
   * Host (no path/query) parsed from `TransportError.url`, when present.
   * Only the host travels — the full URL could carry query params.
   */
  transportHost?: string;
  /** Path-stripped stack frames (basenames only — no home dir / username). */
  frames: SentryStackFrame[];
}

/** Minimal Sentry stack-frame shape (path already reduced to a basename). */
export interface SentryStackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
}

/** Known LLM failure categories (mirror of `src/llm/reliability`). */
const KNOWN_CATEGORIES = new Set([
  "transport",
  "grammar",
  "model",
  "tool",
  "cancelled",
]);

/**
 * Curated allowlist of error class names whose `.message` is guaranteed
 * to be static (no interpolated runtime / user data). **Empty by
 * default** — add a class name here only after auditing every one of its
 * constructor call sites and confirming the message is a fixed literal.
 * Any error not in this set is reported without its message.
 */
export const STATIC_MESSAGE_ERRORS = new Set<string>([]);

/** Mirror of `ModelFailureReason` in `src/llm/reliability/failure-category.ts` — a fixed 3-value enum, safe to allowlist verbatim. */
const KNOWN_MODEL_FAILURE_REASONS = new Set(["truncated", "empty", "no_stop"]);

/**
 * Bounded identifier pattern for tool names (mirrors `MCP_TOOL_NAME_RE` in
 * `src/mcp/mcp-types.ts`). A value that does not match this shape is
 * dropped rather than sent — it could be arbitrary model output rather
 * than a real registry tool name.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;

const MAX_FRAMES = 30;

/**
 * Enum shape for an errno-style code. A value that does not match could
 * be freeform text (and therefore user data), so it is dropped rather
 * than sent.
 */
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/** Depth cap on every `cause` walk in this module — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

// `    at fn (/abs/path/file.js:12:34)` or `    at /abs/path/file.js:12:34`
const FRAME_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/** Read a known LLM failure category off an error, if it carries one. */
export function readKnownCategory(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const category = (err as { category?: unknown }).category;
  if (typeof category === "string" && KNOWN_CATEGORIES.has(category)) {
    return category;
  }
  return undefined;
}

/** Reduce a stack-frame path to a basename, preserving `node:` internals. */
function safeBasename(location: string): string {
  if (location.startsWith("node:")) return location;
  const stripped = location.replace(/^file:\/\//, "");
  const lastSlash = Math.max(
    stripped.lastIndexOf("/"),
    stripped.lastIndexOf("\\"),
  );
  return lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
}

/**
 * Parse a Node `error.stack` into structured frames with every filesystem
 * path reduced to a basename. This strips the home directory / username
 * that dev-build stacks embed while keeping enough to locate the frame in
 * our (bundled) code.
 */
export function sanitizeStack(stack: string | undefined): SentryStackFrame[] {
  if (!stack) return [];
  const frames: SentryStackFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = FRAME_RE.exec(line);
    if (!match) continue;
    const [, fn, location, lineno, colno] = match;
    const frame: SentryStackFrame = {
      filename: safeBasename(location ?? ""),
    };
    if (fn) frame.function = fn;
    if (lineno) frame.lineno = Number.parseInt(lineno, 10);
    if (colno) frame.colno = Number.parseInt(colno, 10);
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/**
 * Extract only safe, enum-like scalar codes from an error.
 *
 * The walk continues into `err.cause` because the error that reaches
 * this function is usually a wrapper: `TransportError` carries no status
 * of its own on the network path, and `GrammarError` carries none at all
 * — the HTTP status lives on the `LlamaServerError` underneath, and the
 * errno one level below that. Reading only the top object is why the
 * largest issue in error reporting has neither an `http_status` nor a
 * `code` tag on a single event.
 *
 * Each field is taken from the outermost link that has it, so a wrapper
 * that DOES carry a status still wins over its cause.
 */
export function extractSafeCode(err: unknown): {
  httpStatus?: number;
  code?: string;
} {
  const out: { httpStatus?: number; code?: string } = {};
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const status = (current as { status?: unknown }).status;
    if (out.httpStatus === undefined && typeof status === "number") {
      out.httpStatus = status;
    }
    const code = (current as { code?: unknown }).code;
    if (
      out.code === undefined &&
      typeof code === "string" &&
      SAFE_CODE_RE.test(code)
    ) {
      out.code = code;
    }
    if (out.httpStatus !== undefined && out.code !== undefined) break;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  return out;
}

/** Read `ModelError.reason` off an error, restricted to the known enum. */
export function extractSafeReason(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const reason = (err as { reason?: unknown }).reason;
  return typeof reason === "string" && KNOWN_MODEL_FAILURE_REASONS.has(reason)
    ? reason
    : undefined;
}

/**
 * Read `ToolExecutionError.tool` off an error, restricted to a bounded
 * identifier shape so freeform / hallucinated text is never sent.
 */
export function extractSafeTool(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const tool = (err as { tool?: unknown }).tool;
  return typeof tool === "string" && SAFE_IDENTIFIER_RE.test(tool)
    ? tool
    : undefined;
}

/**
 * Read the host (no path/query) off `TransportError.url`, when the URL
 * parses cleanly. Only the host travels — llama-server URLs are operator
 * infrastructure config, not user content, but the path/query is dropped
 * defensively in case a custom endpoint ever encodes anything in it.
 */
export function extractSafeTransportHost(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const url = (err as { url?: unknown }).url;
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Choose the frames to report: the cause's, when it has any, else the
 * wrapper's own.
 *
 * Preferring the cause is right — a generic wrapper's `.stack` points at
 * the `new ToolExecutionError(...)` call site, not the throw site. But
 * preferring it *unconditionally* meant that a cause with no parseable
 * frames took the wrapper's frames down with it, and the event shipped
 * with an empty stack. That is not hypothetical: it is how a
 * 108-event issue ended up with no stack trace at all and no way to
 * tell where it came from. Some causes genuinely have nothing — a
 * `DOMException` from an abort, an error rebuilt from a serialized
 * worker message, anything constructed without `Error.captureStackTrace`.
 * A wrapper frame is worth strictly more than nothing.
 */
function pickFrames(
  err: Error,
  causeError: Error | undefined,
): SentryStackFrame[] {
  const causeFrames = causeError ? sanitizeStack(causeError.stack) : [];
  if (causeFrames.length > 0) return causeFrames;
  return sanitizeStack(err.stack);
}

/**
 * Read the underlying `Error` off `err.cause`, when present. Only an
 * `Error` instance is returned — a non-Error cause carries no `.stack` /
 * `.name` worth extracting.
 */
function readCauseError(err: Error): Error | undefined {
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? cause : undefined;
}

/**
 * Build a {@link ScrubbedErrorEvent} from an `Error` using the strict
 * allowlist. `message` is included only when the error's class name is in
 * {@link STATIC_MESSAGE_ERRORS}.
 *
 * When `err` is a generic wrapper built around an original failure (e.g.
 * `toLlmFailure`'s catch-all `ToolExecutionError("unknown", ...)`), the
 * wrapper's own `.stack` only points at the `new ToolExecutionError(...)`
 * call site, not the original throw site — `err.cause` is where the
 * actually useful frames live. Prefer the cause's stack whenever the
 * cause is itself an `Error`; fall back to `err.stack` otherwise so
 * ordinary (non-wrapped) errors are unaffected.
 */
export function scrubError(
  err: Error,
  opts: { source: string; category?: string },
): ScrubbedErrorEvent {
  const errorType = err.name || err.constructor?.name || "Error";
  const category =
    (opts.category && KNOWN_CATEGORIES.has(opts.category)
      ? opts.category
      : undefined) ?? readKnownCategory(err);
  const { httpStatus, code } = extractSafeCode(err);
  const reason = extractSafeReason(err);
  const tool = extractSafeTool(err);
  const transportHost = extractSafeTransportHost(err);
  const causeError = readCauseError(err);
  const causeType = causeError
    ? causeError.name || causeError.constructor?.name || "Error"
    : undefined;
  const event: ScrubbedErrorEvent = {
    errorType,
    source: opts.source,
    frames: pickFrames(err, causeError),
  };
  if (causeType) event.causeType = causeType;
  if (category) event.category = category;
  if (STATIC_MESSAGE_ERRORS.has(errorType) && err.message) {
    event.message = err.message;
  }
  if (httpStatus !== undefined) event.httpStatus = httpStatus;
  if (code !== undefined) event.code = code;
  if (reason !== undefined) event.reason = reason;
  if (tool !== undefined) event.tool = tool;
  if (transportHost !== undefined) event.transportHost = transportHost;
  return event;
}
