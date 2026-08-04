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

/** Extract only safe, enum-like scalar codes from an error. */
export function extractSafeCode(err: unknown): {
  httpStatus?: number;
  code?: string;
} {
  if (typeof err !== "object" || err === null) return {};
  const out: { httpStatus?: number; code?: string } = {};
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") out.httpStatus = status;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) {
    out.code = code;
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
 * Build a {@link ScrubbedErrorEvent} from an `Error` using the strict
 * allowlist. `message` is included only when the error's class name is in
 * {@link STATIC_MESSAGE_ERRORS}.
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
  const event: ScrubbedErrorEvent = {
    errorType,
    source: opts.source,
    frames: sanitizeStack(err.stack),
  };
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
