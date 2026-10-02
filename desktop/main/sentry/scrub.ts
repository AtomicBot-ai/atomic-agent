/**
 * Allowlist scrubbing for desktop error reports, mirroring
 * `src/error-reporting/error-scrubber.ts`: an event is BUILT from safe
 * fields rather than redacted from the raw error.
 *
 *  - the message is dropped unless the error type is on STATIC_MESSAGE_ERRORS
 *    (empty, like the agent's: add a type only after auditing every place
 *    that constructs it);
 *  - the type name is kept only when it is `SomethingError` /
 *    `SomethingException` or one of the shell's own names (KNOWN_TYPES),
 *    else `Error` — a thrown non-Error's "name" can be anything;
 *  - the stack's `Name: message` header (which repeats the message, and can
 *    span lines) is cut off before any frame is read;
 *  - stack frames keep file basename + line/col + function only — the home
 *    directory and every absolute path prefix go (file://, C:\…, /Users/…);
 *  - at most 30 frames. No breadcrumbs, argv or env are ever read.
 *
 * Pure: the unit tests drive it under plain node.
 */

export interface StackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
}

export const STATIC_MESSAGE_ERRORS = new Set<string>([]);
export const MAX_FRAMES = 30;

const TYPE_RE = /^[A-Z][A-Za-z0-9]{0,50}(Error|Exception)$/;
/** Names the shell itself gives its tag-only reports (handlers.ts) and the renderer's stand-ins. */
export const KNOWN_TYPES = new Set<string>([
  "Error", "NonError", "UnhandledRejection", "ChildProcessGone", "RenderProcessGone", "WindowUnresponsive",
  "DidFailLoad", "AgentExited",
]);
const FUNC_RE = /^[\w$.<>\[\] ]{1,128}$/;
/** V8: `at fn (loc:1:2)` / `at loc:1:2` / `at async fn (loc:1:2)`. */
const V8_FRAME_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

export function safeType(name: unknown): string {
  return typeof name === "string" && (KNOWN_TYPES.has(name) || TYPE_RE.test(name)) ? name : "Error";
}

/** The message, only for a type whose messages are known to be static. */
export function safeMessage(type: string, message: unknown): string | undefined {
  return STATIC_MESSAGE_ERRORS.has(type) && typeof message === "string" ? message.slice(0, 200) : undefined;
}

/** Any path (POSIX, Windows, file:// URL, app:// URL) down to its last segment. */
export function safeBasename(location: string): string {
  if (location.startsWith("node:")) return location;
  const stripped = location.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  const parts = stripped.split(/[\\/]/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1]! : "";
  // A drive letter alone, or nothing at all, is not a file name worth sending.
  return /^[\w.@-]{1,128}$/.test(last) ? last : "<redacted>";
}

function safeFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined;
  const clean = fn.replace(/^async /, "").replace(/^new /, "");
  return FUNC_RE.test(clean) ? clean : undefined;
}

/**
 * The frame lines after the header. With the message known, everything up to
 * its end is the header; without it, every line before the first frame line
 * is. A message line that merely looks like a frame is therefore never read.
 */
function frameLines(stack: string, message: unknown): string[] {
  let body = stack;
  if (typeof message === "string" && message) {
    const at = stack.indexOf(message);
    if (at >= 0) body = stack.slice(at + message.length);
  }
  const lines = body.split("\n");
  const first = lines.findIndex((l) => V8_FRAME_RE.test(l));
  return first < 0 ? [] : lines.slice(first);
}

export function sanitizeStack(stack: unknown, message?: unknown): StackFrame[] {
  if (typeof stack !== "string") return [];
  const frames: StackFrame[] = [];
  for (const line of frameLines(stack, message)) {
    const m = V8_FRAME_RE.exec(line);
    if (!m) continue;
    const [, fn, loc, lineno, colno] = m;
    const frame: StackFrame = { filename: safeBasename(loc ?? "") };
    const f = safeFunction(fn);
    if (f) frame.function = f;
    if (lineno) frame.lineno = Number.parseInt(lineno, 10);
    if (colno) frame.colno = Number.parseInt(colno, 10);
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Tag values: short enum-ish strings only. */
export function safeTag(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
  return typeof v === "string" && /^[\w.:-]{1,64}$/.test(v) ? v : undefined;
}
