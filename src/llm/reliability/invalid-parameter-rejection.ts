import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { invalidSamplingParameter } from "../provider/openai/invalid-parameter.js";
import { TransportError } from "./llm-failures.js";

/**
 * Did the provider refuse the request because a sampling setting the
 * agent sent is invalid for the model (ATO-1218)? A 400 or 422 whose
 * wording names the setting next to a refusal word
 * (`invalidSamplingParameter`).
 *
 * Nadya's decision (17.11): a cloud "invalid parameter" error stops the
 * turn with a clear error that names the provider; there is no silent
 * fallback for it. Only a provider that is really down (429 / 5xx /
 * network) moves the turn to the next link, and that switch is announced
 * with the `provider_switched` line.
 *
 * Read by `shouldAdvance`. Wording is matched over the error's `cause`
 * chain, the same way `isRequestSizeRejection` does, because the chat
 * message drops the provider's body text and keeps it on the cause.
 */
export function isInvalidParameterRejection(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== 400 && status !== 422) return false;
  return invalidSamplingParameter(messageChain(error)) !== null;
}

function statusOf(error: unknown): number | null | undefined {
  if (error instanceof OpenAiHttpError) return error.status;
  if (error instanceof LlamaServerError) return error.status;
  if (error instanceof TransportError) return error.status;
  return undefined;
}

/** Depth cap on the `cause` walk — longer is a cycle. */
const MAX_CAUSE_DEPTH = 5;

function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      const body = current instanceof OpenAiHttpError ? current.body?.text : undefined;
      if (typeof body === "string" && body.length > 0) parts.push(body);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}
