import { describe, expect, it } from "vitest";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  parseProviderErrorBody,
  RETRY_HINT_MAX_MS,
} from "../provider/openai/parse-provider-error-body.js";
import { TransportError } from "./llm-failures.js";
import { readProviderErrorVerdict } from "./provider-error-verdict.js";

function httpError(
  status: number,
  text: string,
  options: { label?: string; retryAfterMs?: number | null } = {},
): OpenAiHttpError {
  return new OpenAiHttpError(
    `openai provider ${status}: ${text.slice(0, 300)}`,
    status,
    "https://openrouter.ai/api/v1/chat/completions",
    false,
    options.retryAfterMs ?? null,
    options.label ?? "openrouter",
    undefined,
    { body: parseProviderErrorBody(text) },
  );
}

describe("readProviderErrorVerdict", () => {
  it("reads through the step executor's TransportError wrapper to the provider's body", () => {
    const wrapped = new TransportError(
      '"openrouter" is rate-limiting this key (429).',
      429,
      "https://openrouter.ai/api/v1",
      {
        cause: httpError(
          429,
          JSON.stringify({
            error: {
              message: "Provider returned error",
              metadata: {
                raw: '{"error":{"type":"credit_balance_exhausted","message":"Your credit balance is too low to access the Anthropic API."}}',
              },
            },
          }),
        ),
      },
    );
    expect(readProviderErrorVerdict(wrapped)).toEqual({
      kind: "credit_exhausted",
      provider: "openrouter",
      code: "credit_balance_exhausted",
      detail: "Provider returned error",
    });
  });

  it("names the host when the provider has no label", () => {
    const verdict = readProviderErrorVerdict(
      httpError(402, JSON.stringify({ error: { message: "no credits left" } }), {
        label: "",
      }),
    );
    expect(verdict).toMatchObject({
      kind: "credit_exhausted",
      provider: "openrouter.ai",
    });
  });

  it("clips a cooldown to the maximum a turn will wait", () => {
    const verdict = readProviderErrorVerdict(
      httpError(
        402,
        JSON.stringify({
          error: {
            code: "in_flight_budget_exhausted",
            message: "retry in 10 minutes",
          },
        }),
      ),
    );
    expect(verdict).toEqual({
      kind: "retry_after",
      provider: "openrouter",
      delayMs: RETRY_HINT_MAX_MS,
      code: "in_flight_budget_exhausted",
      detail: "retry in 10 minutes",
    });
  });

  it("is null for a plain outage, a non-HTTP error, and a deep cause chain", () => {
    expect(readProviderErrorVerdict(httpError(503, "upstream down"))).toBeNull();
    expect(readProviderErrorVerdict(new Error("fetch failed"))).toBeNull();
    let deep: Error = httpError(402, JSON.stringify({ error: { code: "insufficient_credits" } }));
    for (let i = 0; i < 6; i += 1) deep = new Error(`layer ${i}`, { cause: deep });
    expect(readProviderErrorVerdict(deep)).toBeNull();
  });
});
