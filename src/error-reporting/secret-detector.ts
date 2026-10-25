/**
 * Credential detector shared by every place that must not pass a secret
 * on (ATO-1077): tool output on its way to the model
 * (`src/tools/tool-output-secrets.ts`) and the error scrubber's message
 * field (`error-scrubber.ts`).
 *
 * `maskSecrets` replaces what it finds with a marker that keeps a short,
 * non-secret hint of what was there: `[redacted:openrouter-key]`,
 * `API_KEY=[redacted:secret]`, `postgres://app:[redacted:password]@db`.
 * The hint lets the model say "the OpenRouter key in .env" without ever
 * holding the key.
 *
 * Three layers, applied in this order:
 *
 *  1. PEM private key blocks, removed whole.
 *  2. Exact values the agent itself knows are secret (`KnownSecret`):
 *     its own `.env` (loaded into `process.env`, see `knownSecretsFromEnv`)
 *     and configured provider keys. This is the only layer that catches
 *     a key with no recognisable shape.
 *  3. Shapes: vendor key formats, bearer/basic credentials, JWTs, a
 *     password in a URL, and `NAME=value` / `"name": "value"` pairs
 *     whose name says secret (the same name test as the shell env filter
 *     of ATO-347, `isSecretEnvName`).
 *
 * Deliberately conservative where a false positive would hurt: a vendor
 * shape has a literal prefix and a word boundary, so hashes, git SHAs,
 * UUIDs and base64 blobs (an image, a wheel) pass untouched; a
 * `NAME=value` pair is masked only when the value looks like a secret
 * (not a number, a path, a URL, a `$VAR` reference or a placeholder).
 *
 * Every pattern is linear: literal prefixes, bounded or
 * single-class quantifiers, no nested ambiguous repetition. Each layer
 * is skipped outright when its literal cannot occur in the text, so a
 * large output with nothing to mask costs a few `includes` scans.
 *
 * Masking is idempotent: a marker is never matched again.
 */

import { isSecretEnvName } from "../sandbox/command-env.js";

/** A value known to be secret, and the non-secret label shown in its place. */
export interface KnownSecret {
  /** Shown in the marker, e.g. `OPENROUTER_API_KEY` or `openrouter-key`. */
  label: string;
  value: string;
}

/** Shortest exact value worth matching: shorter ones would shred ordinary words. */
export const MIN_KNOWN_SECRET_LENGTH = 8;

const MARKER_PREFIX = "[redacted:";

/** The marker put in place of a secret. Labels are reduced to `[A-Za-z0-9_.-]`. */
export function redactedMarker(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 64) || "secret";
  return `${MARKER_PREFIX}${safe}]`;
}

type Rule = {
  /** Cheap pre-check: the rule cannot match when this is false. */
  applies: (text: string) => boolean;
  apply: (text: string) => string;
};

const hasDigit = (s: string): boolean => /\d/.test(s);

/** A vendor shape replaced whole by one marker. */
function shape(
  re: RegExp,
  needle: string | readonly string[],
  label: string | ((match: string) => string),
  accept: (match: string) => boolean = () => true,
): Rule {
  const needles = typeof needle === "string" ? [needle] : needle;
  return {
    applies: (text) => needles.some((n) => text.includes(n)),
    apply: (text) =>
      text.replace(re, (match) =>
        accept(match)
          ? redactedMarker(typeof label === "string" ? label : label(match))
          : match,
      ),
  };
}

/**
 * `-----BEGIN … PRIVATE KEY-----`, its base64 lines (real newlines or
 * JSON-escaped `\n`, optionally indented), legacy `Proc-Type:` /
 * `DEK-Info:` headers, and the END line when present. A block clipped
 * before its END line is still removed up to where the base64 stops.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:(?:\\r\\n|\\n|\r?\n)[ \t]*(?:[A-Za-z0-9+/=]{1,4096}|(?:Proc-Type|DEK-Info): [^\r\n\\]{0,200})?)*(?:(?:\\r\\n|\\n|\r?\n)[ \t]*)?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?/g;

const SHAPE_RULES: readonly Rule[] = [
  // Anthropic (`sk-ant-api03-…`, `sk-ant-oat01-…`) and OpenRouter
  // (`sk-or-v1-…`) before the generic `sk-` shape that would also match.
  shape(/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g, "sk-ant-", "anthropic-key"),
  shape(/(?<![A-Za-z0-9_-])sk-or-[A-Za-z0-9_-]{20,}/g, "sk-or-", "openrouter-key"),
  // OpenAI (`sk-proj-…`, `sk-svcacct-…`, classic `sk-…`) and the many
  // services that copied its shape (DeepSeek, Moonshot, …). A real key
  // has a digit; `sk-` followed by plain words is a CSS class or a slug.
  shape(
    /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
    "sk-",
    (m) => (/^sk-(?:proj|svcacct|admin)-/.test(m) ? "openai-key" : "api-key"),
    hasDigit,
  ),
  shape(
    /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
    ["gh", "github_pat_"],
    "github-token",
  ),
  shape(/(?<![A-Za-z0-9_-])xox[abeoprs]-[A-Za-z0-9-]{10,}/g, "xox", "slack-token", hasDigit),
  // Fixed-length shapes are bounded on both sides by the base64
  // alphabet, so a run of an image's base64 that happens to contain
  // `AKIA` or `AIza` is not taken for a key.
  shape(/(?<![A-Za-z0-9+/])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9+/=])/g, ["AKIA", "ASIA"], "aws-access-key"),
  shape(/(?<![A-Za-z0-9+/_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, "AIza", "google-key"),
  shape(/(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])/g, "hf_", "hf-token"),
  shape(
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "eyJ",
    "jwt",
  ),
  {
    // `Authorization: Basic <base64>` — only after the header name, since
    // "Basic" is an ordinary word.
    applies: (text) => /authorization/i.test(text),
    apply: (text) =>
      text.replace(
        /(\bauthorization["']?[ \t]*[:=][ \t]*["']?basic[ \t]+)[A-Za-z0-9+/]{8,}={0,2}/gi,
        (_m, head: string) => `${head}${redactedMarker("basic-auth")}`,
      ),
  },
  {
    // `Bearer <token>` anywhere: an echoed header, a curl line, a log.
    applies: (text) => /bearer/i.test(text),
    apply: (text) =>
      text.replace(
        /\b((?:[Bb]earer|BEARER)[ \t]+)([A-Za-z0-9._~+/-]{16,}=*)/g,
        (match, head: string, token: string) =>
          hasDigit(token) ? `${head}${redactedMarker("bearer-token")}` : match,
      ),
  },
  {
    // A `Cookie:` / `Set-Cookie:` header line carries session credentials
    // as `name=value` pairs whose names say nothing; the whole value goes.
    applies: (text) => /cookie/i.test(text),
    apply: (text) =>
      text.replace(
        /(\b(?:set-)?cookie[ \t]*:[ \t]*)([^\r\n]{8,4096})/gi,
        (match, head: string, value: string) =>
          value.startsWith(MARKER_PREFIX) ? match : `${head}${redactedMarker("cookie")}`,
      ),
  },
  {
    // `scheme://user:password@host` — the user name stays, the password goes.
    applies: (text) => text.includes("://") && text.includes("@"),
    apply: (text) =>
      text.replace(
        /\b([A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/)([^\s/:@?#]{0,256}):([^\s/@?#]{1,256})@/g,
        (match, scheme: string, user: string, password: string) =>
          password.startsWith(MARKER_PREFIX)
            ? match
            : `${scheme}${user}:${redactedMarker("password")}@`,
      ),
  },
];

/**
 * Name parts that make a pair secret on their own. A name that only
 * passes `isSecretEnvName` through a weaker part (`KEY`, `PAT`, `AUTH`,
 * `COOKIE`) also needs a random-looking value.
 */
const STRONG_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|COOKIE/;

/**
 * Names `isSecretEnvName` would take that describe a secret rather than
 * hold one: counts (`max_tokens`), kinds (`token_type`), where to find
 * it (`api_key_env_var`, `token_url`, `secret_path`) or its id.
 */
const NOT_SECRET_NAME =
  /TOKENIZER|(?:^|_)(?:MAX|NUM|TOTAL|PROMPT|COMPLETION|INPUT|OUTPUT|CACHED|REASONING)_TOKENS?(?:_|$)|_(?:COUNT|LIMIT|TYPE|KIND|FORMAT|ID|URL|URI|PATH|FILE|DIR|NAME|LABEL|ENDPOINT|HEADER|ENV|ENV_VAR|SCOPE|SCOPES|STATUS|VERSION|EXPIRY|EXPIRES|EXPIRES_AT|EXPIRES_IN|EXPIRATION|TTL|LENGTH|PREFIX|HINT|HASH|DIGEST|SHA|CHECKSUM|FINGERPRINT)$/;

/** `apiKey` / `x-api-key` / `db.password` → `API_KEY` / `X_API_KEY` / `DB_PASSWORD`. */
function normaliseName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[.-]+/g, "_")
    .toUpperCase();
}

type NameStrength = "strong" | "weak" | null;

function secretNameStrength(name: string): NameStrength {
  const normalised = normaliseName(name);
  if (NOT_SECRET_NAME.test(normalised)) return null;
  if (!isSecretEnvName(normalised)) return null;
  return STRONG_NAME.test(normalised) ? "strong" : "weak";
}

const LITERAL_WORDS =
  /^(?:true|false|null|none|nil|undefined|yes|no|on|off|enabled|disabled|required|optional|string|number|boolean|redacted|hidden|secret|password|changeme)$/i;

/**
 * Whether a value next to a secret-looking name is plausibly the secret
 * itself, rather than a setting about it.
 */
function looksLikeSecretValue(value: string, strength: "strong" | "weak"): boolean {
  if (value.length < MIN_KNOWN_SECRET_LENGTH) return false;
  if (value.startsWith(MARKER_PREFIX) || value.includes(MARKER_PREFIX)) return false;
  if (/^[\d.,:_-]+$/.test(value)) return false; // numbers, versions, times
  if (LITERAL_WORDS.test(value)) return false;
  // References and placeholders: $VAR, ${VAR}, %VAR%, {{ secret }}, <your-token>.
  if (/^(?:\$|%|\{\{|<)/.test(value)) return false;
  // Paths and plain URLs (a URL with a password is the URL rule's job).
  if (/^(?:\/|\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/.test(value)) {
    return false;
  }
  if (/^(.)\1+$/.test(value)) return false; // ******** / xxxxxxxx
  if (strength === "weak") {
    // `KEY` / `PAT` / `AUTH` alone also name cache keys, object keys and
    // sort keys: only a long, mixed, unbroken value counts, and never a
    // hex digest, a UUID or a path-like `uploads/2024/a.png`.
    return (
      value.length >= 16 &&
      /[A-Za-z]/.test(value) &&
      hasDigit(value) &&
      !/[\s/.]/.test(value) &&
      !/^[0-9a-f-]+$/i.test(value)
    );
  }
  return true;
}

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `--password=value`,
 * `?access_token=value&…`. The name, separator and quotes are kept. An
 * unquoted value stops at `=`, `?` and `&` (base64 padding excepted),
 * so `https://host/?token=…` is read as its query pair rather than as a
 * value of `https`.
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_$])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]*[:=][ \t]*)(?:"([^"\r\n]{1,512})"|'([^'\r\n]{1,512})'|([^\s"'`,;&<>(){}=?]{1,512}={0,3}))/g;

const ASSIGNMENT_RULE: Rule = {
  applies: (text) => text.includes("=") || text.includes(":"),
  apply: (text) =>
    text.replace(
      ASSIGNMENT,
      (
        match: string,
        nameQuote: string,
        name: string,
        sep: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined,
      ) => {
        const strength = secretNameStrength(name);
        if (strength === null) return match;
        const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
        const quoted = doubleQuoted !== undefined || singleQuoted !== undefined;
        if (!quoted && /\s/.test(value)) return match;
        if (quoted && strength === "weak" && /\s/.test(value)) return match;
        if (!looksLikeSecretValue(value, strength)) return match;
        const q = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
        return `${nameQuote}${name}${nameQuote}${sep}${q}${redactedMarker("secret")}${q}`;
      },
    ),
};

/**
 * Whether a known value is worth an exact match: long enough, not a
 * number, path or URL, and not a plain lowercase word. A variable whose
 * name says secret can still hold a setting (`CREDENTIAL_HELPER=osxkeychain`),
 * and masking that word everywhere would shred ordinary output.
 */
function usableKnownValue(value: string): boolean {
  if (!looksLikeSecretValue(value, "strong")) return false;
  return hasDigit(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || /[^A-Za-z0-9_-]/.test(value);
}

/** Usable known secrets, longest first, so a value containing another is replaced whole. */
function usableKnownSecrets(known: readonly KnownSecret[]): KnownSecret[] {
  const seen = new Set<string>();
  const out: KnownSecret[] = [];
  for (const secret of known) {
    const value = secret.value.trim();
    if (seen.has(value)) continue;
    if (!usableKnownValue(value)) continue;
    seen.add(value);
    out.push({ label: secret.label, value });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replace every secret found in `text` with a `[redacted:<hint>]`
 * marker. `known` adds exact values (the agent's own keys) to the
 * pattern layer. Returns `text` itself when nothing was found.
 */
export function maskSecrets(text: string, known: readonly KnownSecret[] = []): string {
  if (text.length < MIN_KNOWN_SECRET_LENGTH) return text;
  let out = text;
  if (out.includes("PRIVATE KEY-----")) {
    out = out.replace(PEM_PRIVATE_KEY, redactedMarker("private-key"));
  }
  for (const secret of usableKnownSecrets(known)) {
    if (out.includes(secret.value)) {
      out = out.split(secret.value).join(redactedMarker(secret.label));
    }
  }
  for (const rule of SHAPE_RULES) {
    if (rule.applies(out)) out = rule.apply(out);
  }
  if (ASSIGNMENT_RULE.applies(out)) out = ASSIGNMENT_RULE.apply(out);
  return out;
}

/**
 * The agent's own secrets out of an environment: every variable whose
 * name `isSecretEnvName` takes (the ATO-347 shell filter's test, which
 * also covers `KNOWN_SECRET_ENV_VARS`), labelled with its name. Bootstrap
 * loads `<stateDir>/.env` into `process.env`, so this is the `.env` too.
 */
export function knownSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < MIN_KNOWN_SECRET_LENGTH) continue;
    if (!isSecretEnvName(name)) continue;
    out.push({ label: name, value });
  }
  return out;
}
