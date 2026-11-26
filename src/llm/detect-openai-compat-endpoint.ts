/**
 * Is this URL an OpenAI-compatible server rather than a llama-server?
 *
 * The first-run "Custom endpoint" branch asks for a llama-server and
 * probes `GET /health`. A hosted OpenAI-compatible endpoint (the common
 * case: `https://models.example.com/v1`) answers 404 there, and the
 * operator was told "local-llm /health failed at …: http 404" — a
 * message about the wrong question. This module asks the right one:
 * does `{base}/v1/models` (or `{base}/models`, for a base that already
 * carries `/v1`) answer with the OpenAI `{ data: [...] }` shape?
 *
 * Kept free of config and UI imports so the onboarding flow, the LLM
 * tab and a future CLI check can all use it.
 */

export interface OpenAiCompatDetection {
  /** The base URL to store on the provider entry (no trailing `/v1`). */
  readonly baseUrl: string;
  /** Model ids the server listed, in its own order. */
  readonly models: readonly string[];
}

/**
 * What a probe of an operator-typed base found.
 *
 * `needs_auth` is the case that used to be reported as "not an
 * OpenAI-compatible endpoint": a hosted gateway answers its model list
 * with 401/403 when no key is sent. That answer *is* proof of the wire
 * format — the route exists and speaks the OpenAI shape — so the caller
 * must ask for a key instead of telling the operator their URL is wrong.
 */
export type OpenAiCompatProbe =
  | { readonly kind: "ok"; readonly detection: OpenAiCompatDetection }
  | { readonly kind: "needs_auth"; readonly baseUrl: string }
  | { readonly kind: "not_openai_compat" };

export interface DetectOpenAiCompatOptions {
  /** Per-request budget. Defaults to 5 s, the onboarding probe's own. */
  readonly timeoutMs?: number;
  /** Bearer key, when the operator already has one. */
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Candidate model-list URLs for one operator-typed base, most likely
 * first. A base that already ends in `/v1` is asked as-is; every other
 * base gets `/v1/models` and then `/models` (some gateways serve the
 * list at the root).
 */
export function modelListCandidates(base: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(base.trim());
  } catch {
    return [];
  }
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  const out: string[] = [];
  const add = (p: string): void => {
    const next = new URL(parsed.toString());
    next.pathname = p;
    const url = next.toString();
    if (!out.includes(url)) out.push(url);
  };
  if (/\/v1$/i.test(path)) {
    add(`${path}/models`);
    add(`${path.replace(/\/v1$/i, "")}/v1/models`);
  } else {
    add(`${path}/v1/models`);
    add(`${path}/models`);
  }
  return out;
}

/**
 * The base URL to store for a detected endpoint: the operator's own
 * base with a trailing `/v1` removed, because every call site appends
 * `/v1/...` itself (`normalizeOpenAiBaseUrl`).
 */
export function providerBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

/**
 * Probe `base` for an OpenAI-compatible model list, reporting *why* it
 * failed when it did.
 *
 * A 401/403 is not a failure to recognise the endpoint: a hosted gateway
 * answers its model list that way when no key was sent, which proves the
 * route exists and speaks the OpenAI shape. That case comes back as
 * `needs_auth` so the caller can ask for a key instead of telling the
 * operator their URL is wrong.
 */
export async function probeOpenAiCompatEndpoint(
  base: string,
  options: DetectOpenAiCompatOptions = {},
): Promise<OpenAiCompatProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  let sawAuthChallenge = false;
  for (const url of modelListCandidates(base)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        sawAuthChallenge = true;
        continue;
      }
      if (!res.ok) continue;
      const parsed: unknown = JSON.parse(await res.text());
      const data = (parsed as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) continue;
      const models = data
        .map((row) => (row as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      return {
        kind: "ok",
        detection: { baseUrl: providerBaseUrl(base), models },
      };
    } catch {
      // A refused connection, a timeout or a non-JSON body: try the next
      // candidate, then give up.
    } finally {
      clearTimeout(timer);
    }
  }
  return sawAuthChallenge
    ? { kind: "needs_auth", baseUrl: providerBaseUrl(base) }
    : { kind: "not_openai_compat" };
}

/**
 * Probe `base` for an OpenAI-compatible model list. Returns `null` when
 * nothing answered in that shape — a llama-server, a dead host and a
 * web page all land there, and the caller keeps its own message.
 *
 * A key-protected endpoint also returns `null` here; callers that can
 * ask for a key should use {@link probeOpenAiCompatEndpoint} instead.
 */
export async function detectOpenAiCompatEndpoint(
  base: string,
  options: DetectOpenAiCompatOptions = {},
): Promise<OpenAiCompatDetection | null> {
  const probe = await probeOpenAiCompatEndpoint(base, options);
  return probe.kind === "ok" ? probe.detection : null;
}
