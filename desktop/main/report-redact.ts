/**
 * What "Save report for support" (Settings › Diagnostics, the `dump` verb)
 * takes out before it writes the report. The screen says the report holds
 * the settings "with keys, tokens and passwords taken out", so that has to
 * hold for every place a config keeps one, not only for keys named like one:
 * an MCP server's `Authorization` header, a `--api-key` argument, a
 * `--header "Authorization: Bearer …"` pair, a `NAME=value` pair, a URL with
 * a password in it, a key in its query or a token in its path.
 *
 * The report also carries the tail of agent.log, and `atag serve`'s own log
 * lines reach that file: error messages, URLs, command lines, whatever a
 * provider answered. The same rules run over it.
 *
 * - `redactSecrets(config)` walks the config. A string goes, replaced by its
 *   length, when its key names a secret, when it is a credential itself
 *   (`Bearer …`), when it follows a flag that names one in an argument list,
 *   or when it is a header line whose name names one; a `NAME=value` or
 *   `--flag=value` string loses its value when the name names a secret.
 *   Whatever is left goes through `scrubText`.
 * - `scrubText(text)` masks, anywhere in a text: key- and token-shaped
 *   strings, Authorization and Bearer values, the value after a flag or in a
 *   `name=value` / `"name": "value"` pair whose name names a secret, a URL's
 *   user:password, the values of its secret query parameters and a path
 *   segment that holds a long token.
 *
 * Everything else is kept as it was: the report is there to show what the app
 * was set to and what the agent said. Pattern-based, so it is a floor, not a
 * promise that nothing personal is left — which is why the screen also says
 * the log can hold parts of recent chats and file paths.
 *
 * The token shapes are the TUI issue report's (`maskSecrets` in
 * src/tui/issue-report/redact.ts). The desktop is built apart from src and
 * cannot import it, so they are repeated here; the two lists move together.
 */

const gone = (s: string) => `<redacted ${s.length} chars>`;
/** Already masked, in whole or in part (`Bearer <redacted 16 chars>`): left alone, so no rule eats another's scheme. */
const isRedacted = (s: string) => s.includes("<redacted");

/* ------------------------------------------------------------- config walk */

/** A config key whose string value is a secret: `apiKey`, `DB_PASS`, `MYSQL_PWD`, `Authorization`, … */
const SECRET_NAME = /key|token|secret|pass|pwd|auth|cookie|credential/i;
const CREDENTIAL = /^\s*(bearer|basic|token)\s+\S/i;
/** A flag whose next argument is a secret: `--api-key sk-…`, `--token x`. */
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|pass|pwd|auth|cookie|credential)[\w-]*$/i;
const NAME_VALUE = /^(--?[\w-]+|[A-Za-z_][\w.-]*)=(.+)$/s;
/** `Authorization: Bearer …`, `x-api-key: …` — a header line, as `--header` / `-H` take one. */
const HEADER_LINE = /^\s*([A-Za-z][\w-]*)\s*:\s*(\S.*)$/s;

function redactString(value: string, key: string): string {
  if (!value) return value;
  if (SECRET_NAME.test(key) || CREDENTIAL.test(value)) return gone(value);
  const header = HEADER_LINE.exec(value);
  if (header && SECRET_NAME.test(header[1]!)) return `${header[1]}: ${gone(header[2]!)}`;
  const pair = NAME_VALUE.exec(value);
  if (pair && SECRET_NAME.test(pair[1]!)) return `${pair[1]}=${gone(pair[2]!)}`;
  return scrubText(value);
}

export function redactSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    // `["--api-key", "sk-…"]`: the element after a flag that names a secret is one.
    return value.map((v, i) => {
      const prev = i > 0 ? value[i - 1] : undefined;
      if (typeof v === "string" && v && typeof prev === "string" && SECRET_FLAG.test(prev)) return gone(v);
      return redactSecrets(v, key);
    });
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactSecrets(v, k);
    return out;
  }
  return typeof value === "string" ? redactString(value, key) : value;
}

/* --------------------------------------------------------------- free text */

/**
 * Key- and token-shaped strings, wherever they stand. Every pattern starts
 * on a literal prefix or at the start of a run, so a long line without one
 * costs a single pass (a 400 KB log tail goes through all of them).
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  // GitHub
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  // OpenAI / Anthropic / OpenRouter and other `sk-` keys
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  // Google (Gemini) API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Hugging Face
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // Slack
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  // Telegram bot tokens — also inside the Bot API's `/bot<token>/` paths
  /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  // JWT-shaped
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  // AWS
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** `Authorization: Bearer x`, `"authorization":"Basic x"`, `authorization=x`: the scheme stays, the credential goes. */
const AUTHORIZATION = /(\bauthorization["']?[ \t]*[:=][ \t]*["']?)(?:(bearer|basic|token|digest)[ \t]+)?([^\s"',;}]+)/gi;
/** A bearer token anywhere else. */
const BEARER = /(\bbearer[ \t]+)([A-Za-z0-9+/=._~-]{8,})/gi;
/** `--api-key sk-…`, `--token=x`: the value after a flag on a command line. */
const FLAG_VALUE = /(^|\s)(--?[A-Za-z][\w-]*)(=|[ \t]+)(?!-)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;
/**
 * `NAME=value`, `name: value`, `"name": "value"` — the value goes when the
 * name names a secret (`namesSecret`). Within one line, and never an object
 * or a list (`"token":{…}` stays as it is).
 */
const PAIR = /(?<![\w.-])(["']?)([A-Za-z][\w.-]*)\1([ \t]*[:=][ \t]*)(?:"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'|([^\s"',;}&<>{[]+))/g;
/** A URL with a scheme, from the start of its word. */
const URL_IN_TEXT = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * Words that name a secret on their own, as the last word of a name.
 * `authorization` is not one of them here: `AUTHORIZATION` takes that pair
 * and keeps its scheme, which this rule would take for the value.
 */
const SECRET_WORDS = new Set([
  "token", "secret", "password", "passwd", "passphrase", "pass", "pwd",
  "credential", "credentials", "cookie", "apikey",
]);
/** Words that make the `key` after them a secret: `apiKey`, `OPENROUTER_API_KEY`, `x-api-key`, `secretKey`. */
const KEY_QUALIFIERS = new Set([
  "api", "access", "secret", "private", "client", "master", "auth",
  "service", "subscription", "license", "encryption", "signing", "app", "account",
]);
/** In a URL's query, these mean a secret too: `?key=` (Google), `?sig=` and `Signature=` (signed URLs), `?auth=`. */
const SECRET_QUERY_WORDS = new Set(["key", "sig", "signature", "auth", "authorization", "jwt"]);

/** The words of a name, lower-cased: `OPENROUTER_API_KEY`, `XApiKey`, `x-api-key`, `client.secret`. Trailing digits are dropped (`GITHUB_TOKEN_2`). */
function wordsOf(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  while (words.length > 1 && /^\d+$/.test(words[words.length - 1]!)) words.pop();
  return words;
}

/**
 * Whether a name in free text names a secret: its last word is one
 * (`DB_PASS`, `sessionToken`, `client_secret`), or it is a qualified key
 * (`apiKey`, `OPENROUTER_API_KEY`). Only the last word counts, so a count
 * keeps its number: `promptTokens`, `maxTokens`, `tokenBudget`.
 */
function namesSecret(name: string): boolean {
  const words = wordsOf(name);
  const last = words[words.length - 1];
  if (!last) return false;
  if (SECRET_WORDS.has(last)) return true;
  return last === "key" && words.length > 1 && KEY_QUALIFIERS.has(words[words.length - 2]!);
}

function queryNamesSecret(name: string): boolean {
  if (namesSecret(name)) return true;
  const words = wordsOf(name);
  return words.some((w) => SECRET_QUERY_WORDS.has(w) || SECRET_WORDS.has(w));
}

/** A path segment holding a token: a run of 24+ letters and digits with both in it (a capability URL, a webhook's secret). */
function holdsToken(segment: string): boolean {
  for (const [run] of segment.matchAll(/[A-Za-z0-9]{24,}/g)) {
    if (/\d/.test(run) && /[A-Za-z]/.test(run)) return true;
  }
  return false;
}

/** One URL: its user:password, its secret query values and its token-holding path segments go; the rest stays. */
function scrubUrl(url: string): string {
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(.*)$/is.exec(url);
  if (!parts) return url;
  const [, scheme, authority, path, rest] = parts as unknown as [string, string, string, string, string];
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : `<redacted>@${authority.slice(at + 1)}`;
  const segments = path.split("/").map((seg) => (holdsToken(seg) ? gone(seg) : seg)).join("/");
  const tail = rest.replace(/([?&#;])([^=&#;\s]+)=([^&#;\s]*)/g, (m, sep: string, name: string, value: string) =>
    value && !isRedacted(value) && queryNamesSecret(name) ? `${sep}${name}=${gone(value)}` : m);
  return scheme + host + segments + tail;
}

/** Mask the secrets in a text — a log tail, or a config string the key rules kept. */
export function scrubText(text: string): string {
  let out = text;
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, (m) => gone(m));
  out = out.replace(URL_IN_TEXT, (url) => scrubUrl(url));
  out = out.replace(AUTHORIZATION, (m, head: string, scheme: string | undefined, value: string) =>
    isRedacted(value) ? m : `${head}${scheme ? scheme + " " : ""}${gone(value)}`);
  out = out.replace(BEARER, (m, head: string, value: string) => (isRedacted(value) ? m : `${head}${gone(value)}`));
  out = out.replace(FLAG_VALUE, (m, lead: string, flag: string, sep: string, value: string) =>
    !isRedacted(value) && namesSecret(flag) ? `${lead}${flag}${sep}${gone(value)}` : m);
  out = out.replace(PAIR, (m, q: string, name: string, sep: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value || isRedacted(value) || /^(null|true|false|undefined)$/.test(value) || !namesSecret(name)) return m;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    return `${q}${name}${q}${sep}${quote}${gone(value)}${quote}`;
  });
  return out;
}

/**
 * The last `maxChars` of a log, from the first whole line in them: a line cut
 * at its start could hold the end of a secret with nothing left to recognise
 * it by.
 */
export function logTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const firstBreak = tail.indexOf("\n");
  return firstBreak === -1 ? "" : tail.slice(firstBreak + 1);
}
