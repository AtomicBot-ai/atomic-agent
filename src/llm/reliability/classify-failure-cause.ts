import { ToolCallParseError } from "../grammar/tool-call-grammar.js";
import { LlamaServerError } from "../llama-server-client.js";
import {
  SubscriptionCliAuthError,
  SubscriptionCliNotInstalledError,
} from "../provider/subscription-cli/subscription-cli-errors.js";
import { classifyFailure } from "./classify-failure.js";
import {
  failureVerdict,
  type FailureCauseId,
  type FailureVerdict,
} from "./failure-catalog.js";
import type { LlmFailureCategory } from "./failure-category.js";
import { GrammarError, ModelError, ToolExecutionError } from "./llm-failures.js";
import { isLocalEngineDown } from "./local-engine-down.js";
import {
  LOCAL_CONTEXT_EXCEEDED_CODE,
  LOCAL_REQUEST_INVALID_CODE,
  classifyLocalServerError,
} from "./local-server-error.js";
import {
  classifyProviderWaitCause,
  type ProviderWaitCause,
} from "./provider-wait-cause.js";
import {
  isRequestSizeRejection,
  requestSizeRejectionNamesContext,
} from "./request-size-rejection.js";

/**
 * Pick the `FAILURE_CATALOG` entry for an error that ended a turn
 * (or a step).
 *
 * It reads only typed facts the error already holds — its class, a
 * status, a flag, a reason — plus two message shapes that have no type
 * of their own: an out-of-memory report and a context-length refusal.
 * It never rewrites the error, and the category the runtime already
 * decided wins on the cases they can disagree on (a cancelled turn).
 *
 * `category` is the one `loop_failed` carries; when omitted it is
 * classified here the same way the loop does.
 *
 * Order matters: the most specific cause first. A GPU that ran out of
 * memory also fails decodes and stalls requests, so memory is named
 * before the timeout or empty reply it shows up as.
 */
export function classifyFailureCause(
  err: unknown,
  category: LlmFailureCategory = classifyFailure(err),
): FailureVerdict {
  return failureVerdict(pickCause(err, category));
}

const MAX_CAUSE_DEPTH = 6;

/** Out-of-memory reports from llama.cpp (Metal, CUDA, Vulkan, CPU) and hosts. */
const OUT_OF_MEMORY =
  /out of memory|OutOfMemory|failed to allocate|insufficient memory|not enough memory|\bOOM\b|cudaMalloc failed|ErrorOutOfDeviceMemory/i;

/** A provider or server refusing a prompt that does not fit its window. */
const CONTEXT_OVERFLOW =
  /context[ _-]?(?:length|window|size)[^.]{0,60}(?:exceed|too (?:long|large|small)|maximum|limit)|exceeds? (?:the |its )?(?:available )?context|maximum context (?:length|window)|prompt is too long|too many tokens in (?:the )?prompt/i;

const WEB_SEARCH_ERROR_NAMES = new Set([
  "WebSearchUnavailableError",
  "WebSearchBlockedError",
  "WebSearchRateLimitedError",
]);

function pickCause(err: unknown, category: LlmFailureCategory): FailureCauseId {
  if (category === "cancelled") return "cancelled";
  if (isLocalEngineDown(err)) return "local_engine_down";

  const chain = causeChain(err);
  const webSearch = chain.find(isWebSearchError);
  if (webSearch !== undefined) {
    return webSearch.keyRequired !== undefined
      ? "web_search_needs_key"
      : "web_search_unavailable";
  }

  const messages = chain
    .filter((link): link is Error => link instanceof Error)
    .map((link) => link.message);
  if (messages.some((m) => OUT_OF_MEMORY.test(m))) return "out_of_memory";

  const modelError = chain.find((l): l is ModelError => l instanceof ModelError);
  if (modelError !== undefined) return modelCause(modelError);

  // A local server's typed HTTP answer already has a code
  // (`local-server-error.ts`, ATO-707/708); the catalog follows it so a
  // 400 is never read as a grammar bug and the frame's `code` and
  // `failure` tell one story.
  const local = classifyLocalServerError(err);
  if (local !== null) {
    if (local.code === LOCAL_CONTEXT_EXCEEDED_CODE) return "context_too_long";
    if (local.code === LOCAL_REQUEST_INVALID_CODE) return "request_rejected";
    return "local_server_not_found";
  }

  if (
    (isRequestSizeRejection(err) && requestSizeRejectionNamesContext(err)) ||
    messages.some((m) => CONTEXT_OVERFLOW.test(m))
  ) {
    return "context_too_long";
  }

  if (
    chain.some(
      (l) => l instanceof GrammarError || l instanceof ToolCallParseError,
    )
  ) {
    return "unreadable_reply";
  }

  // Our own deadline on the local server: the model is slower than the
  // budget, not a provider that went away.
  if (chain.some((l) => l instanceof LlamaServerError && l.timedOut)) {
    return "slow_local_model";
  }

  if (
    chain.some(
      (l) =>
        l instanceof SubscriptionCliNotInstalledError ||
        l instanceof SubscriptionCliAuthError,
    )
  ) {
    return "provider_setup";
  }

  if (category === "transport") {
    return waitCauseToId(classifyProviderWaitCause(err));
  }
  if (chain.some((l) => l instanceof ToolExecutionError)) return "tool_crashed";
  if (category === "grammar") return "unreadable_reply";
  if (category === "model") return "unfinished_reply";
  if (category === "tool") return "tool_crashed";
  return "unknown";
}

function modelCause(err: ModelError): FailureCauseId {
  if (err.reason === "empty") return "empty_response";
  if (err.reason === "no_stop") return "unfinished_reply";
  if (err.truncation?.repetitive === true) return "repeating_output";
  if (err.truncation?.cause === "context_window") return "context_too_long";
  return "reply_cut_off";
}

function waitCauseToId(cause: ProviderWaitCause): FailureCauseId {
  switch (cause.kind) {
    case "billing":
      return "out_of_credit";
    case "refused":
      return "connection_refused";
    case "dropped":
      return "connection_dropped";
    case "unreachable":
      return "offline";
    case "timeout":
      return "provider_timeout";
    case "loading":
      return "model_loading";
    case "stream_error":
    case "error_finish":
      return "provider_error_mid_reply";
    case "http":
      return httpStatusToId(cause.status);
    case "unknown":
      return "provider_unreachable";
  }
}

function httpStatusToId(status: number): FailureCauseId {
  if (status === 429) return "rate_limited";
  if (status === 402) return "out_of_credit";
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 404) return "model_not_found";
  if (status === 408) return "provider_timeout";
  if (status >= 500) return "provider_trouble";
  return "request_rejected";
}

/**
 * A web search failure, read by name: the tool layer owns those classes
 * and this module must not import it. `keyRequired` is the tool's own
 * "an API key would fix this" signal (ATO-327).
 */
function isWebSearchError(
  link: unknown,
): link is Error & { keyRequired?: unknown } {
  return link instanceof Error && WEB_SEARCH_ERROR_NAMES.has(link.name);
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if (chain.includes(current)) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}
