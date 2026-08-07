import { getConfig } from "../config/index.js";

export interface HealthResult {
  reachable: boolean;
  status: number | null;
  /**
   * What actually answered.
   *  - `"llama-server"`: `/health` returned llama.cpp's JSON shape.
   *  - `"llama-loading"`: `/health` returned llama.cpp's 503 while the
   *    model is still loading (new builds answer
   *    `{"error":{"code":503,"message":"Loading model..."}}`, old builds
   *    `{"status":"loading model"}`). The server IS a llama-server; it
   *    just cannot serve yet. Callers should say "wait", not "wrong
   *    server kind".
   *  - `"openai-compat"`: `/health` did not, but `{base}/v1/models`
   *    answered like an OpenAI-compatible server (KoboldCpp, LM Studio,
   *    vLLM). The external llama.cpp route cannot drive these; callers
   *    should steer the operator to the openai-compatible provider.
   *  - `"unknown"`: nothing recognizable answered.
   *
   * A bare HTTP 200 is deliberately NOT enough for `"llama-server"`:
   * KoboldCpp answers 200 with HTML on every path, which used to make
   * the probe pass falsely and let the chat route switch onto a server
   * the llama.cpp client then hangs against (#65, #66).
   */
  kind: "llama-server" | "llama-loading" | "openai-compat" | "unknown";
  error: string | null;
  latencyMs: number;
}

export interface HealthCheckOptions {
  url?: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  apiKey?: string | null;
}

function buildHeaders(apiKey: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function pingOnce(
  url: string,
  timeoutMs: number,
  apiKey: string | null | undefined,
): Promise<HealthResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      // llama.cpp answers /health with 503 while the model is loading:
      // new builds send {"error":{"code":503,"message":"Loading model..."}},
      // old builds {"status":"loading model"}. Both mean "this IS a
      // llama-server, come back in a bit", not "wrong server kind".
      if (response.status === 503 && bodyLooksLikeLlamaLoading(text)) {
        return {
          reachable: false,
          status: response.status,
          error: "llama.cpp is still loading the model",
          kind: "llama-loading",
          latencyMs: Date.now() - start,
        };
      }
      return {
        reachable: false,
        status: response.status,
        error: `http ${response.status}`,
        kind: "unknown",
        latencyMs: Date.now() - start,
      };
    }
    const isLlama = bodyLooksLikeLlamaHealth(text);
    return {
      reachable: isLlama,
      status: response.status,
      error: isLlama
        ? null
        : "answered 200 but not with llama.cpp's /health shape",
      kind: isLlama ? "llama-server" : "unknown",
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      status: null,
      error: message,
      kind: "unknown",
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * llama.cpp's `/health` answers with a small JSON object carrying a
 * `status` string (`ok`, `loading model`, `error`). Anything else that
 * happens to return 200 on that path (KoboldCpp serves its web UI there)
 * is not a llama-server and must not pass the probe.
 */
function bodyLooksLikeLlamaHealth(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { status?: unknown }).status === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Recognizes llama.cpp's 503 "still loading" body. New builds answer
 * `{"error":{"code":503,"message":"Loading model..."}}` (no `status`
 * field); old builds answer `{"status":"loading model"}`.
 */
function bodyLooksLikeLlamaLoading(text: string): boolean {
  if (bodyLooksLikeLlamaHealth(text)) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return false;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.toLowerCase().includes("loading");
  } catch {
    return false;
  }
}

/**
 * Secondary probe for #66: when `/health` says this is not a
 * llama-server, ask `{base}/v1/models`. A JSON answer with a `data`
 * array is the OpenAI-compatible signature shared by KoboldCpp,
 * LM Studio, vLLM and friends. Best-effort with its own timeout;
 * network errors simply report `"unknown"`.
 */
async function probeOpenAiCompat(
  base: string,
  timeoutMs: number,
  apiKey: string | null | undefined,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("/v1/models", base).toString();
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const parsed: unknown = JSON.parse(await response.text());
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { data?: unknown }).data)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pings the external llama-server `/health` endpoint with exponential backoff.
 * Returns the first successful probe or the last failure after all retries.
 */
export async function checkLlamaServer(
  options: HealthCheckOptions = {},
): Promise<HealthResult> {
  const config = getConfig();
  const base = options.url ?? config.localModels.url;
  const url = new URL(config.localModels.healthPath, base).toString();
  const timeoutMs = options.timeoutMs ?? config.localModels.healthTimeoutMs;
  const retries = options.retries ?? config.localModels.healthRetries;
  const backoffMs = options.backoffMs ?? config.localModels.healthRetryBackoffMs;
  const apiKey = options.apiKey ?? config.localModels.apiKey;

  let last: HealthResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await pingOnce(url, timeoutMs, apiKey);
    if (last.reachable) return last;
    // A 200 with a non-llama body is deterministic: the same wrong
    // server (KoboldCpp web UI) will answer the same way on every
    // retry, so burning the whole backoff budget changes nothing.
    // Transient failures (connection refused, timeouts, 503 while
    // loading) still get the retries.
    if (last.status === 200 && last.kind === "unknown") break;
    if (attempt < retries) {
      await wait(backoffMs * Math.pow(2, attempt));
    }
  }
  const failed: HealthResult = last ?? {
    reachable: false,
    status: null,
    error: "no attempts made",
    kind: "unknown",
    latencyMs: 0,
  };
  // Find out whether this is an OpenAI-compatible runner so the caller
  // can say something useful instead of a bare failure (#66). Only worth
  // asking when something HTTP actually answered in a way that suggests
  // a different server kind: a 200 with a non-llama body, or a 404
  // (LM Studio and friends do not serve /health). Skip it when nothing
  // answered at all (connection refused, timeout) and when the server
  // already identified itself as llama.cpp loading a model.
  const suggestsDifferentServer =
    failed.kind === "unknown" &&
    (failed.status === 200 || failed.status === 404);
  if (suggestsDifferentServer && (await probeOpenAiCompat(base, timeoutMs, apiKey))) {
    return { ...failed, kind: "openai-compat" };
  }
  return failed;
}
