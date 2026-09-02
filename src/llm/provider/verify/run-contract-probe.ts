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
 *  2. **`tool_choice: auto`**, same tools payload — reached when rung 1
 *     was *refused* for a reason that is not the key, the quota or the
 *     model, or when it was *accepted and ignored*. This is the mode a
 *     real turn runs in (`step-executor` sends `auto` on every request,
 *     deliberately — several providers reject a forced choice outright),
 *     so a tool call here is proof about the shape Atomic actually uses:
 *     after a refusal it means only the forcing was unacceptable, and
 *     after an ignored forcing it means the route emits tool calls
 *     regardless.
 *  3. **no tools at all**, same model, same streaming transport —
 *     reached only when both tool *requests* were refused. If this
 *     answers, the route works and it is specifically `tools` it
 *     rejects; if it fails too, the failure was never about tools. It is
 *     skipped when rung 1 streamed, because a stream already proved the
 *     route takes `tools` and the control could only mislead.
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
 * short enough that a wizard screen does not feel hung — every caller
 * runs it with an operator watching, which is why this is the only
 * budget in the module: a second, laxer default nobody passes would
 * only describe a timeout that never happens.
 *
 * Blowing it is *our* verdict, not the route's: see `runRung`, which
 * reports `timeout` rather than inventing a stream defect out of a slow
 * route.
 */
export const PROVIDER_CONTRACT_PROBE_TIMEOUT_MS = 12_000;

/** Ceiling on the SSE body we buffer. A probe answer is a few hundred bytes. */
const MAX_STREAM_BYTES = 64 * 1024;

/**
 * The cap a real turn always carries. `buildOpenAiChatBody` sets
 * `max_tokens` on every request unconditionally and has no
 * `max_completion_tokens` fallback, so a route that refuses the field
 * refuses every Atomic turn — exactly the class of failure this probe
 * exists to catch, and one it would miss by leaving the cap out.
 *
 * The value only has to be far above what one call to a single-field
 * function costs; what a route validates is the field, not the number.
 * Generous on purpose: a thinking model can spend hundreds of tokens
 * before it calls anything, and a cap that truncated the answer would
 * report our own doing as a route defect. `classifyProbeStream` guards
 * the remainder of that risk by reading `finish_reason: "length"` as
 * inconclusive.
 */
const PROBE_MAX_TOKENS = 1024;

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
  const forced = await run(probeBody(target, model, "required_named"));
  if (forced.kind === "aborted") {
    return emit(forced.status, null, "required_named", forced.detail);
  }
  // What rung 1 left open, in the two shapes rung 2 has to tell apart.
  // Exactly one of these is set by the time rung 2 runs; anything else
  // rung 1 saw was already the verdict and returned above.
  let forcedRefusal: { httpStatus: number; body: string } | null = null;
  let forcedIgnored: { httpStatus: number; detail: string } | null = null;
  if (forced.kind === "stream") {
    const forcedStatus = classifyProbeStream(forced.observation, "required_named");
    if (forcedStatus !== "forced_tool_choice_ignored") {
      return emit(
        forcedStatus,
        forced.httpStatus,
        "required_named",
        streamDetail(forced.observation),
      );
    }
    // The route took `tool_choice` and then answered prose anyway. That
    // is a real observation about the route, but it is not yet an
    // answer about Atomic: turns never force a tool (`step-executor`
    // sends `auto`), so what still has to be settled is whether this
    // route emits tool calls in the mode it will actually be run in.
    forcedIgnored = {
      httpStatus: forced.httpStatus,
      detail: streamDetail(forced.observation),
    };
  } else {
    const forcedStatus = classifyContractProbeHttpFailure(
      forced.httpStatus,
      forced.body,
    );
    if (contractProbeFailureIsTerminal(forcedStatus)) {
      return emit(forcedStatus, forced.httpStatus, "required_named", forced.body);
    }
    forcedRefusal = { httpStatus: forced.httpStatus, body: forced.body };
  }

  // Rung 2 — same payload, no forcing. This is the request a turn makes.
  const auto = await run(probeBody(target, model, "auto"));
  if (auto.kind === "aborted") {
    return emit(auto.status, null, "auto", auto.detail);
  }
  if (auto.kind === "stream") {
    const autoStatus = classifyProbeStream(auto.observation, "auto");
    // Tools work; it was the forced choice rung 1 asked for that this
    // route would not take. Reporting rung 2's own verdict here would
    // hide the limitation, so it keeps its own status — one that says
    // "usable", because `auto` is all a turn ever sends.
    if (autoStatus === "tools_supported" && forcedRefusal) {
      return emit(
        "forced_tool_choice_rejected",
        forcedRefusal.httpStatus,
        "required_named",
        forcedRefusal.body,
      );
    }
    // Forcing ignored *and* nothing called under `auto`: two requests
    // and not one tool call. Still not proof that the route cannot emit
    // them — a model may simply keep declining a pointless function —
    // but "it ignores a forced choice" is the sharper of the two
    // observations, so that is the one reported.
    if (forcedIgnored && autoStatus === "inconclusive_no_tool_call") {
      return emit(
        "forced_tool_choice_ignored",
        forcedIgnored.httpStatus,
        "required_named",
        forcedIgnored.detail,
      );
    }
    return emit(autoStatus, auto.httpStatus, "auto", streamDetail(auto.observation));
  }
  const autoStatus = classifyContractProbeHttpFailure(auto.httpStatus, auto.body);
  if (contractProbeFailureIsTerminal(autoStatus)) {
    return emit(autoStatus, auto.httpStatus, "auto", auto.body);
  }
  if (forcedIgnored) {
    // Rung 1 streamed, so this route demonstrably accepts `tools`; the
    // no-tools control could not attribute rung 2's refusal to them and
    // would only spend a request to reach a wrong sentence.
    return emit(autoStatus, auto.httpStatus, "auto", auto.body);
  }

  // Rung 3 — the control. Same model, same streaming transport, no tools.
  const control = await run(probeBody(target, model, null));
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
  // remaining budget itself, and the operator's abort as well.
  const sse = await readStreamBounded(
    res,
    ctx.deadline - Date.now(),
    ctx.signal,
  );
  if (sse.aborted || ctx.signal?.aborted) {
    return { kind: "aborted", status: "cancelled", detail: "probe cancelled" };
  }
  const observation = accumulateProbeStream(sse.text);
  // Our own deadline is not a route defect. A single byte is enough to
  // put text in the buffer — OpenRouter sends `: OPENROUTER PROCESSING`
  // while a request is queued, and a reasoning model can take seconds
  // over its first token — so keying this off "no bytes arrived" would
  // report every slow route as `stream_early_eof` ("turns will end
  // mid-tool-call"), a defect we invented by giving up first. Only a
  // stream that announced its own end before the timer fired is a
  // complete observation worth classifying.
  if (sse.timedOut && !observation.terminalObserved) {
    return {
      kind: "aborted",
      status: "timeout",
      detail: `no complete stream before deadline (${sse.text.length} bytes read)`,
    };
  }
  return { kind: "stream", httpStatus: res.status, observation };
}

/**
 * The probe request, in the same shape `buildOpenAiChatBody` gives a
 * real turn — the streamed transport, the tools payload,
 * `parallel_tool_calls`, and the `max_tokens` cap a turn always carries.
 * Sending anything less would let a route pass the probe and then fail
 * the first message on a field the probe never showed it.
 *
 * `mode === null` is the control: no tools, no tool choice, otherwise
 * identical, so a difference in outcome can only be the tools payload.
 *
 * The one field a turn sends that this cannot is `parallel_tool_calls`'
 * *value* — a turn computes it from the provider's declared capability
 * and the executor's cap. The target carries it when the caller knows
 * it; `true` is what a wizard-saved cloud provider gets by default.
 */
function probeBody(
  target: ProviderContractProbeTarget,
  model: string,
  mode: ProbeToolChoiceMode | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    temperature: 0,
    max_tokens: PROBE_MAX_TOKENS,
    stream: true,
  };
  if (mode === null) return body;
  body.tools = [contractProbeToolDefinition()];
  body.parallel_tool_calls = target.parallelToolCalls ?? true;
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
 * Buffer the SSE body under a byte ceiling, a deadline and the caller's
 * abort, cancelling the stream rather than leaving a socket open behind
 * us.
 *
 * All three outcomes are reported separately because they mean
 * different things about the route: a body that simply stopped is the
 * early EOF the probe is hunting for, while a deadline or an abort is
 * something *we* did and must never be dressed up as one.
 */
async function readStreamBounded(
  res: Response,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; timedOut: boolean; aborted: boolean }> {
  if (!res.body) {
    return { text: await res.text().catch(() => ""), timedOut: false, aborted: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timedOut = false;
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline =
      budgetMs > 0
        ? new Promise<"deadline">((resolve) => {
            timer = setTimeout(() => resolve("deadline"), budgetMs);
          })
        : Promise.resolve<"deadline">("deadline");
    // A stalled stream does not reject on abort by itself on every
    // transport, so the signal is raced rather than waited for: an
    // operator pressing Esc must get the screen back now, not at the
    // deadline.
    const cancelled = new Promise<"aborted">((resolve) => {
      if (!signal) return;
      if (signal.aborted) {
        resolve("aborted");
        return;
      }
      onAbort = () => resolve("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    for (;;) {
      const next = await Promise.race([reader.read(), deadline, cancelled]);
      if (next === "aborted") {
        aborted = true;
        break;
      }
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
  } catch (err) {
    // A stream that breaks mid-body is exactly the early-EOF case: keep
    // what arrived and let the classifier see that it never terminated.
    // Unless it broke because the caller aborted the request, which is
    // not a fact about the route at all.
    if (signal?.aborted || isAbortError(err)) aborted = true;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
  return { text, timedOut, aborted };
}
