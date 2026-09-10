/**
 * Text redaction for issue reports.
 *
 * Two tiers, because they answer two different questions:
 *
 * - `maskSecrets` — "could this string let someone act as the
 *   operator?" Applied at every level, including `full`: API keys,
 *   GitHub / Slack / OpenAI-shaped tokens and bearer headers are never
 *   wanted in a bug report, whatever else the operator chose to share.
 * - `redactPersonal` — "does this string say who or where the operator
 *   is?" Applied at `scrubbed`: the home directory, other users' home
 *   directories, emails, IPv4 addresses and URL query strings. Paths
 *   under the working directory keep their tail (`<cwd>/src/x.ts`) so a
 *   stack trace still points at a file.
 *
 * Pattern-based, so it is a best-effort layer under the level choice,
 * not a substitute for it: the `errors` level is the one that drops
 * the free text altogether.
 */

export interface RedactionContext {
  /** `os.homedir()` — replaced by `~`. */
  homeDir: string;
  /** The session working directory — replaced by `<cwd>`. */
  workingDir?: string;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // GitHub
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "<token>"],
  // OpenAI / Anthropic / generic `sk-` keys
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "<key>"],
  // Slack / Discord / Telegram bot tokens
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, "<token>"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "<token>"],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "<token>"],
  // Authorization headers of any scheme
  [
    /(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[A-Za-z0-9+/=._-]+/gi,
    "$1<redacted>",
  ],
  [/(\bbearer\s+)[A-Za-z0-9+/=._-]{16,}/gi, "$1<redacted>"],
  // KEY=value lines and JSON fields whose name says secret
  [
    /((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
    "$1<redacted>",
  ],
  // AWS
  [/\bAKIA[0-9A-Z]{16}\b/g, "<key>"],
  // Credentials embedded in a URL
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@"],
];

export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/g;
// Any user's home under the common roots, not just the operator's own.
const OTHER_HOMES = /(?:\/Users|\/home)\/[^/\s"'`]+/g;
// Both the literal form and the JSON-escaped form a log line carries.
const WINDOWS_HOMES = /[A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\)[^\\\s"'`]+/g;
/**
 * Any absolute path of two or more segments that is not already under
 * `<cwd>` / `~` / a URL. The `errors` level uses this so a path under
 * `/Volumes/ClientName/…` or `/opt/…` — which the home and cwd rules
 * cannot know about — does not leave the machine either.
 */
const ABSOLUTE_PATH =
  /(?<![\w<~>/.:])(?:[A-Za-z]:)?(?:[\\/][^\s\\/"'`:)\]>]+){2,}/g;

export function redactPersonal(text: string, ctx: RedactionContext): string {
  let out = text;
  if (ctx.workingDir && ctx.workingDir.length > 1) {
    out = replacePathPrefix(out, ctx.workingDir, "<cwd>");
    out = replacePathPrefix(out, toForwardSlashes(ctx.workingDir), "<cwd>");
  }
  if (ctx.homeDir.length > 1) {
    out = replacePathPrefix(out, ctx.homeDir, "~");
    out = replacePathPrefix(out, toForwardSlashes(ctx.homeDir), "~");
  }
  out = out.replace(OTHER_HOMES, "~");
  out = out.replace(WINDOWS_HOMES, "~");
  out = out.replace(EMAIL, "<email>");
  out = out.replace(IPV4, (ip) => (isLoopback(ip) ? ip : "<ip>"));
  out = out.replace(URL_QUERY, "$1?<query>");
  return out;
}

/** Replace every absolute path that survived the home / cwd rules. */
export function redactPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, "<path>");
}

/**
 * Replace `prefix` only where it ends a path segment, so `/Users/v/proj`
 * does not eat the front of `/Users/v/proj-2/x`.
 */
function replacePathPrefix(
  text: string,
  prefix: string,
  replacement: string,
): string {
  if (!text.includes(prefix)) return text;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`${escaped}(?=[\\/\\\\\\s"'\`:)\\]>,]|$)`, "g"),
    replacement,
  );
}

/** `maskSecrets` then `redactPersonal` — the `scrubbed` level's pass. */
export function scrubText(text: string, ctx: RedactionContext): string {
  return redactPersonal(maskSecrets(text), ctx);
}

/**
 * Apply a string transform to every string inside a JSON-ish value,
 * keys included. Used on log contexts, tool args and trace payloads so
 * a path hiding three levels down in an object is treated exactly like
 * one at the top.
 */
export function mapStrings(
  value: unknown,
  fn: (s: string) => string,
  depth = 0,
): unknown {
  if (depth > 32) return "<too deep>";
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value))
    return value.map((v) => mapStrings(v, fn, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[fn(k)] = mapStrings(v, fn, depth + 1);
    }
    return out;
  }
  return value;
}

function isLoopback(ip: string): boolean {
  return ip.startsWith("127.") || ip === "0.0.0.0";
}

function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}
