/**
 * Prove a cloud API key is usable before anything is written to disk.
 *
 * A key can be well-formed, present in `.env` and completely dead: wrong
 * service, revoked, or attached to an account with no credit. `/v1/models`
 * does not settle it — plenty of endpoints list models for an
 * unauthenticated caller, and none of them charge for the listing. The
 * only answer that proves both authentication and funds is a real
 * completion, so this asks for exactly one token from the cheapest model
 * available (see `pick-probe-models`).
 */

import {
  openAiFetch,
  type OpenAiHttpDeps,
} from "../openai/openai-http.js";
import {
  classifyVerifyResponse,
  classifyVerifyTransportError,
  isAbortError,
} from "./classify-verify-response.js";
import type {
  ProviderVerifyResult,
  ProviderVerifyStatus,
  ProviderVerifyTarget,
} from "./verify-types.js";

/**
 * Short on purpose. This runs while the operator watches a wizard, and
 * a slow provider is a reason to save with a warning, not to freeze the
 * screen for the 600s a normal completion is allowed.
 */
export const PROVIDER_VERIFY_TIMEOUT_MS = 8_000;

/** model → other token field → next model. Never more than that. */
const MAX_VERIFY_REQUESTS = 3;

/** Provider error bodies are quoted back bounded, same cap as the HTTP layer. */
const VERIFY_DETAIL_MAX_LEN = 300;

export async function verifyProviderKey(
  target: ProviderVerifyTarget,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ProviderVerifyResult> {
  const startedAt = Date.now();
  const models = target.probeModels.filter((id) => id.length > 0);
  if (models.length === 0) {
    return result("model_unavailable", null, null, "no model to test with", startedAt);
  }

  const deps: OpenAiHttpDeps = {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    extraHeaders: target.extraHeaders ?? {},
    requestTimeoutMs: opts.timeoutMs ?? PROVIDER_VERIFY_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? fetch,
    label: target.label,
  };
  const path = `${target.apiPathPrefix}/chat/completions`;

  let requests = 0;
  let tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  let lastVerdict: {
    status: ProviderVerifyStatus;
    model: string;
    httpStatus: number;
    detail: string;
  } | null = null;

  for (const model of models) {
    // The token-field retry is per model: an endpoint that wants
    // `max_completion_tokens` wants it for the next candidate too.
    for (;;) {
      if (requests >= MAX_VERIFY_REQUESTS) {
        return lastVerdict
          ? result(
              lastVerdict.status,
              lastVerdict.model,
              lastVerdict.httpStatus,
              lastVerdict.detail,
              startedAt,
              target.apiKey,
            )
          : result("model_unavailable", model, null, "no usable model", startedAt);
      }
      if (opts.signal?.aborted) {
        return result("cancelled", model, null, "check cancelled", startedAt);
      }
      requests += 1;

      let res: Response;
      try {
        res = await openAiFetch(
          deps,
          path,
          probeBody(model, tokenField),
          { ...(opts.signal ? { signal: opts.signal } : {}) },
          false,
          "POST",
        );
      } catch (err) {
        if (opts.signal?.aborted || isAbortError(err)) {
          return result("cancelled", model, null, "check cancelled", startedAt);
        }
        const status = classifyVerifyTransportError(err);
        return result(
          status,
          model,
          null,
          err instanceof Error ? err.message : String(err),
          startedAt,
          target.apiKey,
        );
      }

      const body = res.ok ? "" : await readBounded(res);
      const verdict = classifyVerifyResponse(res.status, body);
      if (verdict.kind === "retry_token_field" && tokenField === "max_tokens") {
        tokenField = "max_completion_tokens";
        continue;
      }
      if (verdict.kind === "retry_next_model" || verdict.kind === "retry_token_field") {
        lastVerdict = {
          status: "model_unavailable",
          model,
          httpStatus: res.status,
          detail: body,
        };
        break;
      }
      return result(verdict.status, model, res.status, body, startedAt, target.apiKey);
    }
  }

  return lastVerdict
    ? result(
        lastVerdict.status,
        lastVerdict.model,
        lastVerdict.httpStatus,
        lastVerdict.detail,
        startedAt,
        target.apiKey,
      )
    : result("model_unavailable", models[0] ?? null, null, "no usable model", startedAt);
}

/**
 * One token, no sampling, no tools. Hand-built rather than reusing
 * `buildOpenAiChatBody`, which pulls token limits out of the config and
 * adds tool plumbing a probe has no use for.
 */
function probeBody(
  model: string,
  tokenField: "max_tokens" | "max_completion_tokens",
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: "ping" }],
    [tokenField]: 1,
    temperature: 0,
    stream: false,
  };
}

async function readBounded(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, VERIFY_DETAIL_MAX_LEN);
}

function result(
  status: ProviderVerifyStatus,
  probedModel: string | null,
  httpStatus: number | null,
  detail: string,
  startedAt: number,
  apiKey = "",
): ProviderVerifyResult {
  return {
    status,
    probedModel,
    httpStatus,
    detail: redactKey(detail, apiKey).slice(0, VERIFY_DETAIL_MAX_LEN),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Some providers echo the offending credential back in the error body,
 * and this detail is headed for a status line and the log file.
 */
function redactKey(detail: string, apiKey: string): string {
  if (apiKey.length < 8) return detail;
  return detail.split(apiKey).join("***");
}
