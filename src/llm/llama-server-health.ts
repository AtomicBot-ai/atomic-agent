import { getConfig } from "../config/index.js";

export interface HealthResult {
  reachable: boolean;
  status: number | null;
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
    return {
      reachable: response.ok,
      status: response.status,
      error: response.ok ? null : `http ${response.status}`,
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      status: null,
      error: message,
      latencyMs: Date.now() - start,
    };
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
  return (
    last ?? {
      reachable: false,
      status: null,
      error: "no attempts made",
      latencyMs: 0,
    }
  );
}
