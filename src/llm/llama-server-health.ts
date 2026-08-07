import { getConfig } from "../config/index.js";

export interface HealthResult {
  reachable: boolean;
  status: number | null;
  /**
   * What actually answered.
   *  - `"llama-server"`: `/health` returned llama.cpp's JSON shape.
   *  - `"openai-compat"`: `/health` did not, but `{base}/v1/models`
   *    answered like an OpenAI-compatible server (KoboldCpp, LM Studio,
   *    vLLM). The external llama.cpp route cannot drive these; callers
   *    should steer the operator to the openai-compatible provider.
   *  - `"unknown"`: nothing recognisable answered.
   *
   * A bare HTTP 200 is deliberately NOT enough for `"llama-server"`:
   * KoboldCpp answers 200 with HTML on every path, which used to make
   * the probe pass falsely and let the chat route switch onto a server
   * the llama.cpp client then hangs against (#65, #66).
   */
  kind: "llama-server" | "openai-compat" | "unknown";
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
    if (!response.ok) {
      return {
        reachable: false,
        status: response.status,
        error: `http ${response.status}`,
        kind: "unknown",
        latencyMs: Date.now() - start,
      };
    }
    const isLlama = await bodyLooksLikeLlamaHealth(response);
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
async function bodyLooksLikeLlamaHealth(response: Response): Promise<boolean> {
  try {
    const text = await response.text();
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
  // The server is not a llama-server; find out whether it is an
  // OpenAI-compatible runner so the caller can say something useful
  // instead of a bare failure (#66).
  if (await probeOpenAiCompat(base, timeoutMs, apiKey)) {
    return { ...failed, kind: "openai-compat" };
  }
  return failed;
}
