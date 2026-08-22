import type { HealthResult } from "./llama-server-health.js";
import { llamaEndpointUrl } from "./llama-endpoint-url.js";

/**
 * Second-stage probe for `verifyAuth`: ask the key-guarded `/props` with
 * whatever key we would use for real requests. Only an explicit 401/403
 * flips the verdict — any other answer (older build without /props,
 * transient network blip) keeps the passing `/health` result, because
 * "reachable but degraded" must never read as "server missing".
 */
export async function verifyGuardedEndpoint(
  passed: HealthResult,
  base: string,
  timeoutMs: number,
  apiKey: string | null | undefined,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(llamaEndpointUrl(base, "/props"), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ...passed,
        reachable: false,
        status: response.status,
        kind: "llama-auth",
        error: apiKey
          ? `http ${response.status} — the server rejected the configured API key`
          : `http ${response.status} — the server requires an API key (--api-key)`,
      };
    }
    return passed;
  } catch {
    return passed;
  } finally {
    clearTimeout(timer);
  }
}
