/**
 * Prove — or fail to prove — that a route can run an Atomic turn.
 *
 * A turn is a streamed chat completion that carries a `tools` payload
 * and gets a native tool call back. `/v1/models` proves none of that,
 * and neither does the one-token key check: both are non-streaming, both
 * send no tools. Routes that pass them and then fail a real turn are
 * common enough that the failure has a name in the field reports
 * (`STREAM_EARLY_EOF`, "HTTP 400, but only with tools").
 *
 * So this sends the real thing, once, with a synthetic function nobody
 * has registered, and reads what comes back.
 *
 * ## The ladder
 *
 * Each rung only runs when the one above it left the question open, so
 * a healthy route costs exactly one request:
 *
 *  1. **forced named tool**, streaming, tools payload. A complete tool
 *     call here is the whole answer: `tools_supported`.
 *  2. **`tool_choice: auto`**, same tools payload — reached only when
 *     rung 1 was *refused* for a reason that is not the key, the quota
 *     or the model. A tool call now means the payload is fine and it
 *     was the forcing the route would not take.
 *  3. **no tools at all**, same model, same streaming transport —
 *     reached only when both tool requests were refused. If this
 *     answers, the route works and it is specifically `tools` it
 *     rejects; if it fails too, the failure was never about tools.
 *
 * Rung 3 is what turns "HTTP 400" into a sentence an operator can act
 * on, and it is deliberately an experiment rather than a regex over the
 * error body: provider wording for "tools unsupported" is not stable,
 * but "refuses with tools, answers without them" is unambiguous.
 *
 * ## What it never does
 *
 * The synthetic call is read and discarded. It is never looked up in,
 * dispatched to, or registered with the tool registry — the probe does
 * not import it and could not reach it. And nothing here runs per turn:
 * the only callers are setup-time or an explicit operator request.
 */

import { openAiFetch, type OpenAiHttpDeps } from "../openai/openai-http.js";
import {
  accumulateProbeStream,
  type ProbeStreamObservation,
} from "./accumulate-probe-stream.js";
import {
  classifyContractProbeHttpFailure,
  classifyProbeStream,
  contractProbeFailureIsTerminal,
} from "./classify-contract-probe.js";
import { isAbortError, classifyVerifyTransportError } from "./classify-verify-response.js";
import {
  CONTRACT_PROBE_TOOL_NAME,
  contractProbeToolDefinition,
  type ProbeToolChoiceMode,
  type ProviderContractProbeResult,
  type ProviderContractProbeTarget,
  type ProviderContractStatus,
} from "./contract-probe-types.js";
import { redactProviderDetail } from "./redact-provider-detail.js";

/**
 * Whole-probe budget, not per request. Longer than the key check's 8s
 * because this one waits for a model to actually generate, but still
 * short enough that a wizard screen does not feel hung: a route that
 * cannot produce a two-field tool call inside this is a finding in
 * itself.
 */
export const PROVIDER_CONTRACT_PROBE_TIMEOUT_MS = 20_000;

/** Ceiling on the SSE body we buffer. A probe answer is a few hundred bytes. */
const MAX_STREAM_BYTES = 64 * 1024;

/** The whole ladder: forced → auto → no-tools. Never more than that. */
const MAX_PROBE_REQUESTS = 3;

const PROBE_PROMPT =
  `Call the ${CONTRACT_PROBE_TOOL_NAME} function with ok set to true. ` +
  `Do not answer in words.`;

export async function runProviderContractProbe(
  target: ProviderContractProbeTarget,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ProviderContractProbeResult> {
  const startedAt = Date.now();
  const budgetMs = opts.timeoutMs ?? PROVIDER_CONTRACT_PROBE_TIMEOUT_MS;
  const deadline = startedAt + budgetMs;
  const model = target.model.trim();
  const state = { requests: 0 };

  const emit = (
    status: ProviderContractStatus,
    httpStatus: number | null,
    mode: ProbeToolChoiceMode | null,
    detail: string,
  ): ProviderContractProbeResult => ({
    status,
    probedModel: model,
    httpStatus,
    toolChoiceMode: mode,
    detail: redactProviderDetail(detail, target.apiKey),
    latencyMs: Date.now() - startedAt,
    requests: state.requests,
  });

  if (model.length === 0) {
    return emit("model_unavailable", null, null, "no model configured to probe");
  }

  const run = async (body: Record<string, unknown>): Promise<RungOutcome> =>
    runRung(target, body, {
      deadline,
      state,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

  // Rung 1 — the real contract, forced.
  const forced = await run(probeBody(model, "required_named"));
  if (forced.kind === "aborted") {
    return emit(forced.status, null, "required_named", forced.detail);
  }
  if (forced.kind === "stream") {
    return emit(
      classifyProbeStream(forced.observation, "required_named"),
      forced.httpStatus,
      "required_named",
      streamDetail(forced.observation),
    );
  }
  const forcedStatus = classifyContractProbeHttpFailure(
    forced.httpStatus,
    forced.body,
  );
  if (contractProbeFailureIsTerminal(forcedStatus)) {
    return emit(forcedStatus, forced.httpStatus, "required_named", forced.body);
  }

  // Rung 2 — same payload, no forcing.
  const auto = await run(probeBody(model, "auto"));
  if (auto.kind === "aborted") {
    return emit(auto.status, null, "auto", auto.detail);
  }
  if (auto.kind === "stream") {
    const autoStatus = classifyProbeStream(auto.observation, "auto");
    // Tools work; it was the forced choice rung 1 asked for that this
    // route would not take. Reporting rung 2's own verdict here would
    // hide the actual limitation behind a cheerful "supported".
    if (autoStatus === "tools_supported") {
      return emit(
        "forced_tool_choice_rejected",
        forced.httpStatus,
        "required_named",
        forced.body,
      );
    }
    return emit(autoStatus, auto.httpStatus, "auto", streamDetail(auto.observation));
  }
  const autoStatus = classifyContractProbeHttpFailure(auto.httpStatus, auto.body);
  if (contractProbeFailureIsTerminal(autoStatus)) {
    return emit(autoStatus, auto.httpStatus, "auto", auto.body);
  }

  // Rung 3 — the control. Same model, same streaming transport, no tools.
  const control = await run(probeBody(model, null));
  if (control.kind === "aborted") {
    return emit(control.status, null, null, control.detail);
  }
  if (control.kind === "stream") {
    // It answers without tools and refuses with them. That is the
    // finding, stated from evidence rather than from error wording.
    return emit("tools_payload_rejected", auto.httpStatus, "auto", auto.body);
  }
  const controlStatus = classifyContractProbeHttpFailure(
    control.httpStatus,
    control.body,
  );
  // The control failed too, so nothing here was ever about tools.
  return emit(
    contractProbeFailureIsTerminal(controlStatus) ? controlStatus : "provider_error",
    control.httpStatus,
    null,
    control.body,
  );
}

type RungOutcome =
  | { kind: "stream"; httpStatus: number; observation: ProbeStreamObservation }
  | { kind: "http_error"; httpStatus: number; body: string }
  | {
      kind: "aborted";
      status: Extract<
        ProviderContractStatus,
        "timeout" | "cancelled" | "unreachable" | "provider_error"
      >;
      detail: string;
    };

async function runRung(
  target: ProviderContractProbeTarget,
  body: Record<string, unknown>,
  ctx: {
    deadline: number;
    state: { requests: number };
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  },
): Promise<RungOutcome> {
  if (ctx.signal?.aborted) {
    return { kind: "aborted", status: "cancelled", detail: "probe cancelled" };
  }
  if (ctx.state.requests >= MAX_PROBE_REQUESTS) {
    return {
      kind: "aborted",
      status: "provider_error",
      detail: "probe budget spent",
    };
  }
  const remainingMs = ctx.deadline - Date.now();
  if (remainingMs <= 0) {
    return { kind: "aborted", status: "timeout", detail: "probe deadline reached" };
  }
  ctx.state.requests += 1;

  const deps: OpenAiHttpDeps = {
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    extraHeaders: target.extraHeaders ?? {},
    requestTimeoutMs: remainingMs,
    fetchImpl: ctx.fetchImpl ?? fetch,
    label: target.label,
  };

  let res: Response;
  try {
    res = await openAiFetch(
      deps,
      `${target.apiPathPrefix}/chat/completions`,
      body,
      { ...(ctx.signal ? { signal: ctx.signal } : {}) },
      true,
      "POST",
    );
  } catch (err) {
    if (ctx.signal?.aborted || isAbortError(err)) {
      return { kind: "aborted", status: "cancelled", detail: "probe cancelled" };
    }
    // Transport failures are read by the key check's classifier, so a
    // refused connection or an expired deadline means the same thing in
    // both checks. Only its `cancelled` verdict is unreachable here —
    // that case is handled above.
    const transport = classifyVerifyTransportError(err);
    const status =
      transport === "timeout" || transport === "unreachable"
        ? transport
        : "provider_error";
    return {
      kind: "aborted",
      status,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { kind: "http_error", httpStatus: res.status, body: text };
  }

  // `openAiFetch`'s own timeout covers the connect only — it clears the
  // timer the moment headers arrive. A route that opens a stream and
  // then stalls forever would hang here, so the body read carries the
  // remaining budget itself.
  const sse = await readStreamBounded(res, ctx.deadline - Date.now());
  if (sse.timedOut && sse.text.length === 0) {
    return {
      kind: "aborted",
      status: "timeout",
      detail: "no stream data before deadline",
    };
  }
  return {
    kind: "stream",
    httpStatus: res.status,
    observation: accumulateProbeStream(sse.text),
  };
}

/**
 * The probe request, in the same shape `buildOpenAiChatBody` gives a
 * real turn — including `parallel_tool_calls`, which some routes
 * validate and which a turn always sends alongside tools.
 *
 * `mode === null` is the control: no tools, no tool choice, otherwise
 * identical, so a difference in outcome can only be the tools payload.
 *
 * No `max_tokens`. The one-token key check has to cap spend and
 * therefore has to guess between `max_tokens` and
 * `max_completion_tokens` (newer OpenAI models reject the former).
 * Here a cap would risk truncating the very tool call being measured,
 * reporting malformed deltas that were in fact our own doing — and one
 * forced call to a single-field function is cheap enough uncapped.
 */
function probeBody(
  model: string,
  mode: ProbeToolChoiceMode | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    temperature: 0,
    stream: true,
  };
  if (mode === null) return body;
  body.tools = [contractProbeToolDefinition()];
  body.parallel_tool_calls = true;
  body.tool_choice =
    mode === "required_named"
      ? { type: "function", function: { name: CONTRACT_PROBE_TOOL_NAME } }
      : "auto";
  return body;
}

/**
 * A one-line summary of what the stream contained. Deliberately not the
 * body: the assistant text is the model's own words about a synthetic
 * function and has no diagnostic value worth logging.
 */
function streamDetail(observation: ProbeStreamObservation): string {
  const names = observation.toolCalls
    .map((call) => (call.name.length > 0 ? call.name : "<unnamed>"))
    .join(", ");
  return [
    `finish_reason=${observation.finishReason ?? "none"}`,
    `terminal=${observation.terminalObserved}`,
    `tool_call_deltas=${observation.sawToolCallDelta}`,
    `tool_calls=[${names}]`,
    `text_chars=${observation.text.length}`,
  ].join(" ");
}

/**
 * Buffer the SSE body under a byte ceiling and a deadline, cancelling
 * the stream rather than leaving a socket open behind us.
 */
async function readStreamBounded(
  res: Response,
  budgetMs: number,
): Promise<{ text: string; timedOut: boolean }> {
  if (!res.body) return { text: await res.text().catch(() => ""), timedOut: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline =
      budgetMs > 0
        ? new Promise<"deadline">((resolve) => {
            timer = setTimeout(() => resolve("deadline"), budgetMs);
          })
        : Promise.resolve<"deadline">("deadline");
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "deadline") {
        timedOut = true;
        break;
      }
      if (next.done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(next.value, { stream: true });
      if (text.length >= MAX_STREAM_BYTES) break;
    }
  } catch {
    // A stream that breaks mid-body is exactly the early-EOF case: keep
    // what arrived and let the classifier see that it never terminated.
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return { text, timedOut };
}
