/**
 * Settings › Connections › Linear (ATO-2464): the one request that checks a
 * Linear API key before the window saves it.
 *
 * The renderer cannot ask Linear itself (its CSP has `connect-src 'none'`),
 * so main makes the call `atag connect linear` makes
 * (src/channels/linear/linear-api.ts `viewer`): one GraphQL POST for the
 * key's own user. The answer carries that user's id and name, so the tab can
 * make the key's user the owner, as the CLI does by default.
 *
 * Linear answers an unknown key with 401, or with a GraphQL error whose
 * `extensions.code` is AUTHENTICATION_ERROR; both are `rejected` and the
 * window saves nothing. Anything else that is not an answer (offline, a 5xx,
 * a timeout) is `unreachable`, and the window saves nothing either, again as
 * the CLI does. The key goes into the Authorization header and nowhere else:
 * no log line, no analytics property and no answer carries it, and the
 * answers carry no server text, only a verdict the window words itself.
 */

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const CHECK_TIMEOUT_MS = 15_000;

/* One run of printable ASCII, no spaces, 20 to 512 characters: a personal key
   (`lin_api_…`) or an app token (`lin_oauth_…`). renderer/linear-settings.js
   LN_KEY_RE, checked again here because the value crosses IPC and becomes a header. */
const LINEAR_SECRET_RE = /^[\x21-\x7e]{20,512}$/;
export const LINEAR_KEY_INVALID = "That does not look like a Linear API key.";
export const LINEAR_SECRET_INVALID = "That does not look like a Linear webhook signing secret.";

/** Why a key or signing secret cannot be written as given, or null. Never quotes the value back. */
export function linearSecretValueError(name: string, value: unknown): string | null {
  if (typeof value === "string" && LINEAR_SECRET_RE.test(value)) return null;
  return name === "LINEAR_WEBHOOK_SECRET" ? LINEAR_SECRET_INVALID : LINEAR_KEY_INVALID;
}

export type LinearKeyCheck =
  | { ok: true; viewer: { id: string; name: string } }
  /** `rejected`: Linear refused the key; `unreachable`: it could not be checked; `invalid`: not shaped like a key. */
  | { ok: false; reason: "rejected" | "unreachable" | "invalid" };

export interface CheckLinearKeyOptions {
  key: unknown;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** `viewer { id name }` as a verdict instead of a throw. */
export async function checkLinearKey(opts: CheckLinearKeyOptions): Promise<LinearKeyCheck> {
  if (linearSecretValueError("LINEAR_API_KEY", opts.key)) return { ok: false, reason: "invalid" };
  const key = opts.key as string;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url ?? LINEAR_GRAPHQL_URL, {
      method: "POST",
      // A personal key goes in as is, anything else as a bearer token (linear-api.ts linearAuthHeader).
      headers: { "content-type": "application/json", authorization: key.startsWith("lin_api_") ? key : `Bearer ${key}` },
      body: JSON.stringify({ query: "query { viewer { id name } }" }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "rejected" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const errors = Array.isArray(obj.errors) ? (obj.errors as Array<Record<string, unknown>>) : [];
  const authError = errors.some((e) => {
    const ext = e && typeof e.extensions === "object" && e.extensions ? (e.extensions as Record<string, unknown>) : {};
    return ext.code === "AUTHENTICATION_ERROR" || ext.type === "authentication error";
  });
  if (authError) return { ok: false, reason: "rejected" };
  const data = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : {};
  const viewer = data.viewer && typeof data.viewer === "object" ? (data.viewer as Record<string, unknown>) : null;
  if (!res.ok || !viewer || typeof viewer.id !== "string" || !viewer.id) return { ok: false, reason: "unreachable" };
  return { ok: true, viewer: { id: viewer.id, name: typeof viewer.name === "string" ? viewer.name : "" } };
}
