import { LlamaServerError } from "../llama-server-client.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliNotInstalledError,
} from "../provider/subscription-cli/subscription-cli-errors.js";
import { ToolCallParseError } from "../grammar/tool-call-grammar.js";
import type { LlmFailureCategory } from "./failure-category.js";
import { LlmFailure } from "./llm-failures.js";
import { isNetworkError } from "./network-error.js";

/**
 * llama-server 4xx statuses that describe the *endpoint*, not the request
 * we sent it: the URL does not serve completions (404 — a wrong
 * `localModels.url`, or a server that is not a llama-server at all), the
 * method is not allowed (405), a proxy in front of it wants credentials
 * (401/402/403), or the server is busy / timing us out / conflicting
 * (408/409/429). None of these repeat identically on a different provider,
 * so they are `transport`: the link is unusable, try the next one.
 *
 * Everything else in the 4xx range stays `grammar` — 400/413/422 are the
 * server telling us THIS request was malformed or too large, which the
 * next link would reject the same way.
 */
const LLAMA_ENDPOINT_UNAVAILABLE_STATUSES = new Set([
  401, 402, 403, 404, 405, 408, 409, 429,
]);

/**
 * Classify any thrown value into the canonical failure taxonomy.
 *
 * The step executor and agent loop wrap most errors into `LlmFailure`
 * subclasses before they bubble up, so `instanceof LlmFailure` is the
 * fast path. The remaining branches cover raw errors that reach the
 * classifier from legacy surfaces (direct `LlamaServerError` throws,
 * grammar parser errors, abort signals, and anything else treated as
 * a tool-layer problem by default).
 *
 * The governing rule across every branch: a failure that means "this
 * provider is unusable" must not land in a category that blocks
 * fallover. `shouldAdvance` only advances on `transport` / `model`, so
 * filing an unusable link under `grammar` or `tool` pins the chain to a
 * permanently broken provider and hands the user a diagnosis for a
 * problem they do not have.
 *
 * The `isNetworkError` branch sits between the abort check and that
 * default: an untyped socket failure (MCP streamable-http, embeddings,
 * a vendor SDK with its own `fetch`) is a `transport` problem even
 * though no typed client wrapped it. Filing one as `tool` is wrong in
 * both directions — the user reads "Turn failed [tool]" for someone
 * else's dead socket, and `shouldAdvance` refuses to fall over to the
 * next provider because a tool failure is by definition our own bug.
 */
export function classifyFailure(err: unknown): LlmFailureCategory {
  if (err instanceof LlmFailure) return err.category;
  if (err instanceof ToolCallParseError) return "grammar";
  if (err instanceof LlamaServerError) {
    if (err.status === null) return "transport";
    if (err.status >= 500) return "transport";
    if (LLAMA_ENDPOINT_UNAVAILABLE_STATUSES.has(err.status)) return "transport";
    return "grammar";
  }
  // Cloud provider failures are provider-boundary problems whatever the
  // status — a 429 or 401 is no more "our tool broke" than a 503. The
  // retry budget was already spent inside the HTTP client, matching the
  // TransportError contract.
  if (err instanceof OpenAiHttpError) return "transport";
  // A CLI-backed provider whose binary is missing or signed out is the
  // same shape of problem as an unreachable HTTP endpoint: this link
  // cannot serve the turn, and no other link is implicated. The default
  // `tool` arm below would both mislabel it ("Turn failed [tool]" for a
  // binary the user never installed) and stop the chain dead.
  if (
    err instanceof SubscriptionCliNotInstalledError ||
    err instanceof SubscriptionCliAuthError
  ) {
    return "transport";
  }
  if (isAbortError(err)) return "cancelled";
  // Checked after the abort branch on purpose: an aborted request can
  // surface as ECONNRESET, and a user pressing Esc is not a fallover.
  if (isNetworkError(err)) return "transport";
  return "tool";
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string" && /\baborted\b/i.test(message)) return true;
  return false;
}
