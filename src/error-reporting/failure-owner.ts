import { classifyTransportHost } from "./classify-transport-host.js";

/**
 * Who has to act on a provider's HTTP refusal, as one fixed word
 * (ATO-2419). Sentry's cloud provider clusters mix two very different
 * things under one `TransportError`: the person's own honest 4xx (a bad
 * or missing key, no credit, a rate limit, a model id the provider does
 * not serve) and refusals of a request WE built wrong (tool results out
 * of order, a schema, roles, a parameter, empty content). The tag says
 * which pile an event belongs to; `captureError` leaves most `person`
 * refusals out of Sentry altogether (ATO-1673, `person-refusal.ts`).
 *
 *  - `person`: the account or the setup is the fix (401/403 from a cloud
 *    host, 402, 404, 413, 429, or a reason that says so: `key_refused`,
 *    `out_of_credit`, `model_not_found`, `request_too_large`), and a
 *    cloud model the person picked that takes no tools
 *    (`tools_unsupported`, ATO-1673). From a server on this machine that
 *    reason stays `unknown`: the managed engine started without tool
 *    support would be ours.
 *  - `ours`: the provider read the request and named a part of it we
 *    built (`tool_result_missing`, `roles_must_alternate`, ...).
 *  - `provider`: the provider's own trouble (5xx, 529 overloaded, 408).
 *  - `unknown`: nothing above is provable, for example a 400 the reason
 *    vocabulary does not know (`other`), or a 401/403 from a server on
 *    this machine or network: that is the managed engine refusing our
 *    own key (ours) or a server the person started with a key (theirs),
 *    and the status cannot tell which.
 *
 * Read on the machine from the status and the `upstream_reason` word
 * only; a tag, never part of the fingerprint.
 */
export type FailureOwner = "person" | "ours" | "provider" | "unknown";

/** Reasons that name the account or the person's choice of model. */
const PERSON_REASONS: ReadonlySet<string> = new Set([
  "key_refused",
  "out_of_credit",
  "model_not_found",
  "request_too_large",
]);

/** Reasons that name a part of the request the agent built. */
const OUR_REASONS: ReadonlySet<string> = new Set([
  "context_overflow",
  "missing_thought_signature",
  "missing_reasoning_content",
  "tool_result_missing",
  "tool_result_orphan",
  "tool_schema_invalid",
  "tool_name_invalid",
  "must_end_with_user",
  "trailing_whitespace",
  "roles_must_alternate",
  "empty_content",
  "reasoning_param",
  "temperature",
  "max_tokens",
  "unsupported_parameter",
  "malformed_body",
]);

/** Statuses that are the person's account or setup on a cloud host. */
const PERSON_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404, 413, 429]);

/** How far down `cause` the request URL is looked for. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The owner of a refusal with `httpStatus`, or undefined when the
 * provider did not answer with a status at all (a network failure has
 * no owner this tag can name).
 */
export function classifyFailureOwner(
  httpStatus: number | undefined,
  upstreamReason: string | undefined,
  hostIsLocal: boolean,
): FailureOwner | undefined {
  if (httpStatus === undefined || httpStatus < 400) return undefined;
  if (httpStatus >= 500 || httpStatus === 408) return "provider";
  if ((httpStatus === 401 || httpStatus === 403) && hostIsLocal) return "unknown";
  if (upstreamReason === "tools_unsupported") return hostIsLocal ? "unknown" : "person";
  if (upstreamReason !== undefined && PERSON_REASONS.has(upstreamReason)) return "person";
  if (PERSON_STATUSES.has(httpStatus)) return "person";
  if (upstreamReason !== undefined && OUR_REASONS.has(upstreamReason)) return "ours";
  return "unknown";
}

/**
 * True when the first `.url` on the error's `cause` chain is on this
 * machine or its network (`classifyTransportHost`). The URL never
 * leaves this function.
 */
export function requestHostIsLocal(err: unknown): boolean {
  const url = requestUrlOf(err);
  if (url === undefined) return false;
  const host = classifyTransportHost(url);
  return host === "localhost" || host === "private";
}

/**
 * The first non-empty `.url` on the error's `cause` chain, for reading
 * on this machine only: it is never put on an event.
 */
export function requestUrlOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const url = (current as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}
