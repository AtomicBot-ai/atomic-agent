/**
 * What an `os.http.request` approval prompt shows (ATO-1182, ATO-1471).
 *
 * The prompt reaches the terminal, the desktop app, Telegram and
 * Discord, and the approval ledger keeps its reason. A credential in it
 * is one more copy of that credential, so the prompt masks:
 *  - credential header values (`Authorization: Bearer ****`);
 *  - query and fragment parameters whose name says secret
 *    (`?api_key=****`, `token=`, `access_token=`, `sig=`, ...) and any
 *    other value the shared detector (`secret-detector.ts`) flags;
 *  - the same in the body: form fields by name, JSON fields by key, and
 *    whatever the detector finds in any other body.
 *
 * Only what is shown is masked: the request itself goes out unchanged.
 */
import { maskSecrets } from "../../../error-reporting/secret-detector.js";
import { isSensitiveHeaderName } from "./http-request-fetch.js";

/** Shown in place of a masked value. */
export const MASK = "****";

/** How much of the (masked) body the prompt shows. */
const BODY_PREVIEW_CHARS = 400;

export interface HttpPreviewArgs {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** The preview text: request line, headers, a blank line and the body. */
export function buildHttpApprovalPreview(args: HttpPreviewArgs): string {
  const lines: string[] = [`${args.method} ${maskUrlSecrets(args.url)}`];
  for (const [k, v] of Object.entries(args.headers)) {
    lines.push(`${k}: ${isSensitiveHeaderName(k) ? maskHeaderValue(v) : v}`);
  }
  if (args.body !== undefined) {
    const masked = maskBodySecrets(args.body, contentType(args.headers));
    // Masked before cutting, so a secret across the cut is never half shown.
    const snippet =
      masked.length > BODY_PREVIEW_CHARS
        ? `${masked.slice(0, BODY_PREVIEW_CHARS)}… [${args.body.length} bytes]`
        : masked;
    lines.push("");
    lines.push(snippet);
  }
  return lines.join("\n");
}

/**
 * Parameter names that carry a secret but that the header-name test
 * misses because they are too short or too generic to match by
 * substring: `sig`, `pwd`, an OAuth `code`.
 */
const SECRET_PARAM_NAMES = new Set([
  "sig",
  "pwd",
  "pass",
  "passwd",
  "otp",
  "code",
  "jwt",
  "hmac",
  "client_secret",
]);

/** Whether a query, form or JSON field name says its value is a secret. */
export function isSecretParamName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (SECRET_PARAM_NAMES.has(lower)) return true;
  // `X-Amz-Signature`, `api_key`, `access_token`, `apiKey`, `password`.
  return isSensitiveHeaderName(lower);
}

/**
 * `url` with the values of secret query / fragment parameters masked,
 * and a password in the authority or a known key shape in the path
 * masked by the shared detector. A URL with nothing secret comes back
 * as written.
 */
export function maskUrlSecrets(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? undefined : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? undefined : beforeHash.slice(queryAt + 1);
  let out = maskSecrets(base);
  if (query !== undefined) out += `?${maskParamString(query)}`;
  // An OAuth implicit flow puts `access_token=` in the fragment.
  if (hash !== undefined) {
    out += `#${hash.includes("=") ? maskParamString(hash) : maskSecrets(hash)}`;
  }
  return out;
}

/**
 * `a=1&api_key=xyz` → `a=1&api_key=****`. Names are kept as written;
 * a value is masked when its name says secret or the detector flags it.
 */
export function maskParamString(params: string): string {
  return params
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value.length === 0) return pair;
      const decodedName = decodeParam(name);
      const decodedValue = decodeParam(value);
      if (
        isSecretParamName(decodedName) ||
        maskSecrets(decodedValue) !== decodedValue ||
        maskSecrets(`${decodedName}=${decodedValue}`) !== `${decodedName}=${decodedValue}`
      ) {
        return `${name}=${MASK}`;
      }
      return pair;
    })
    .join("&");
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** Deepest JSON nesting walked; below it the detector still runs on the text. */
const MAX_JSON_DEPTH = 32;

/**
 * The body as the prompt shows it. A form body is masked field by
 * field, a JSON body key by key (re-serialised only when something was
 * masked), and every body goes through the shared detector.
 */
export function maskBodySecrets(body: string, type: string | undefined): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const { value, changed } = maskJson(parsed, 0);
      if (changed) return maskSecrets(JSON.stringify(value));
    } catch {
      // Not JSON after all: fall through to the detector.
    }
    return maskSecrets(body);
  }
  if (isFormBody(body, type)) return maskSecrets(maskParamString(body));
  return maskSecrets(body);
}

function maskJson(value: unknown, depth: number): { value: unknown; changed: boolean } {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object") {
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = maskJson(item, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: changed ? out : value, changed };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      isSecretParamName(key) &&
      (typeof item === "string" || typeof item === "number") &&
      String(item).length > 0
    ) {
      out[key] = MASK;
      changed = true;
      continue;
    }
    const r = maskJson(item, depth + 1);
    changed ||= r.changed;
    out[key] = r.value;
  }
  return { value: changed ? out : value, changed };
}

/** A urlencoded form: by its Content-Type, or by looking like `a=b&c=d`. */
function isFormBody(body: string, type: string | undefined): boolean {
  if (type !== undefined && /application\/x-www-form-urlencoded/i.test(type)) return true;
  return /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/.test(body.trim());
}

function contentType(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return value;
  }
  return undefined;
}

/**
 * Auth scheme words (RFC 9110 / IANA registry, plus common vendor ones)
 * the preview may keep in front of the mask. Anything else is treated as
 * part of the secret: `X-Auth-Token: abc123 def456` must not show
 * `abc123`.
 */
const AUTH_SCHEMES = new Set([
  "basic",
  "bearer",
  "digest",
  "token",
  "negotiate",
  "ntlm",
  "hoba",
  "mutual",
  "vapid",
  "aws4-hmac-sha256",
  "dpop",
  "gnap",
  "privatetoken",
]);

/**
 * The value of a credential header as the approval preview shows it: a
 * known scheme word kept (`Bearer ****`, `Basic ****`), everything else
 * masked.
 */
export function maskHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const scheme = /^(\S+)\s+\S/.exec(trimmed);
  return scheme && AUTH_SCHEMES.has(scheme[1]!.toLowerCase())
    ? `${scheme[1]} ${MASK}`
    : MASK;
}
