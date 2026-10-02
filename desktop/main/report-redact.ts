/**
 * What "Save report for support" (Settings › Diagnostics, the `dump` verb)
 * takes out of the config before it writes it. The screen says the report
 * holds the settings "with keys, tokens and passwords taken out", so that has
 * to hold for every place a config keeps one, not only for keys named like
 * one: an MCP server's `Authorization` header, a `--api-key` argument, a
 * `NAME=value` pair, a URL with a password in it.
 *
 * A string goes, replaced by its length, when its key names a secret, when it
 * is a credential itself (`Bearer …`, `Basic …`), or when it follows a flag
 * that names one in an argument list; a `NAME=value` or `--flag=value` string
 * loses its value when the name names a secret; and the user:password part of
 * a URL goes wherever the URL sits. Everything else is kept as it was: the
 * report is there to show what the app was set to.
 */

const SECRET_NAME = /key|token|secret|passw|auth|cookie|credential/i;
const CREDENTIAL = /^\s*(bearer|basic|token)\s+\S/i;
const SECRET_FLAG = /^--?[\w-]*(key|token|secret|passw|auth|cookie|credential)[\w-]*$/i;
const NAME_VALUE = /^(--?[\w-]+|[A-Za-z_][\w.-]*)=(.+)$/s;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

const gone = (s: string) => `<redacted ${s.length} chars>`;

function redactString(value: string, key: string): string {
  if (!value) return value;
  if (SECRET_NAME.test(key) || CREDENTIAL.test(value)) return gone(value);
  const pair = NAME_VALUE.exec(value);
  if (pair && SECRET_NAME.test(pair[1]!)) return `${pair[1]}=${gone(pair[2]!)}`;
  return value.replace(URL_USERINFO, "$1<redacted>@");
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
