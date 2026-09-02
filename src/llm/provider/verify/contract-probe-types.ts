/**
 * Shapes for the provider *contract* probe — the second question a
 * setup flow has to ask.
 *
 * `verify-provider-key` settles whether the credential is live and
 * funded. It cannot settle whether the route behind that credential can
 * run an Atomic turn, because a turn is not a one-token completion: it
 * is a **streamed** chat completion carrying a `tools` payload, from
 * which a **native tool call** has to come back whole. Routes exist that
 * pass the key check and then fail exactly one of those: the stream ends
 * early, HTTP 400 appears only once `tools` is in the body, forced tool
 * choice is refused, or the tool-call deltas arrive incomplete.
 *
 * Kept free of config and UI imports for the same reason the key check
 * is: the wizard, onboarding and an explicit "test this provider"
 * action all have to be able to run it.
 */

/**
 * The tool the probe offers. It is a *diagnostic fixture*, never an
 * Atomic tool: nothing registers it, nothing dispatches it, and the
 * model's call to it is read and thrown away. The name is deliberately
 * outside the dotted namespace every built-in tool uses
 * (`os.fs.read`, `browser.navigate`, …) so it cannot shadow a real one,
 * and it stays inside the `^[A-Za-z0-9_-]{1,64}$` shape the strict
 * providers validate function names against.
 */
export const CONTRACT_PROBE_TOOL_NAME = "atomic_contract_probe";

/**
 * Which tool-choice mode a probe request ran in. `required_named` is the
 * primary instrument — it is the only mode where "no tool call" is a
 * real answer about the route rather than about the model's mood.
 */
export type ProbeToolChoiceMode = "required_named" | "auto";

export type ProviderContractStatus =
  /** One complete native tool call came back over the stream. */
  | "tools_supported"
  /**
   * The route took the tools payload but produced no callable tool for
   * a reason that says nothing about the route: it answered in prose
   * under `tool_choice: auto` (legal for a model), or the probe's own
   * `max_tokens` cut the answer short.
   */
  | "inconclusive_no_tool_call"
  /**
   * The route accepted a forced named tool choice and then answered
   * text anyway — it advertises the parameter without honoring it — and
   * called nothing under `auto` either. The second half matters: `auto`
   * is the only mode a turn uses, so a route that ignores forcing but
   * calls tools without it is reported as working, not as this.
   */
  | "forced_tool_choice_ignored"
  /**
   * The route refused the request while forcing a named tool, but ran
   * the same tools payload under `auto` and produced a tool call.
   */
  | "forced_tool_choice_rejected"
  /**
   * The route refused every request that carried `tools`, and answered
   * the same streamed completion once `tools` was removed.
   */
  | "tools_payload_rejected"
  /**
   * The route refused the `max_tokens` cap every Atomic turn carries
   * (newer OpenAI models want `max_completion_tokens` instead). Nothing
   * was learned about tools, and nothing needed to be: the turn path
   * has no second field to try, so it would fail the same way.
   */
  | "token_cap_rejected"
  /** The configured model is unknown to this route. */
  | "model_unavailable"
  /** The endpoint refused the credential; nothing else was learned. */
  | "endpoint_auth_failed"
  /** Out of quota, or the gateway could not route to a backend. */
  | "quota_or_routing_failed"
  /** The stream closed with neither a finish reason nor `[DONE]`. */
  | "stream_early_eof"
  /**
   * Tool-call deltas arrived but never assembled into a dispatchable
   * call: no function name, a name nobody offered, or arguments that
   * are not JSON.
   */
  | "malformed_tool_call"
  /** No HTTP response at all: DNS, refused connection, TLS, offline. */
  | "unreachable"
  /** The probe's own deadline fired first. */
  | "timeout"
  /** The operator (or the caller) aborted the probe. */
  | "cancelled"
  /** The route failed in a way that says nothing about tool support. */
  | "provider_error";

export interface ProviderContractProbeTarget {
  /** Service name for user-facing wording ("OpenRouter", "Groq"). */
  readonly label: string;
  /** API root without the version prefix, already normalized. */
  readonly baseUrl: string;
  /** Version prefix the service uses: `/v1`, Gemini's `/v1beta/openai`. */
  readonly apiPathPrefix: string;
  /** Trimmed key, or `""` for a service that authenticates without one. */
  readonly apiKey: string;
  /**
   * The model the operator is about to run turns with. Not a cheap
   * stand-in: route limitations are per-model, so probing anything else
   * would answer a question nobody asked.
   */
  readonly model: string;
  readonly extraHeaders?: Record<string, string>;
  /**
   * What a turn would put in `parallel_tool_calls` for this provider —
   * the executor's cap and the provider's declared capability, resolved
   * by the caller because neither is visible from here. Defaults to
   * `true`, which is what `buildOpenAiChatBody` sends for a provider
   * that declares nothing.
   */
  readonly parallelToolCalls?: boolean;
}

export interface ProviderContractProbeResult {
  readonly status: ProviderContractStatus;
  readonly probedModel: string;
  /** Status of the request the verdict came from, `null` if none did. */
  readonly httpStatus: number | null;
  /** The mode the verdict came from; `null` when no request was made. */
  readonly toolChoiceMode: ProbeToolChoiceMode | null;
  /**
   * A bounded, credential-scrubbed excerpt of what the provider said —
   * enough for a status line and the log, never the whole body.
   */
  readonly detail: string;
  readonly latencyMs: number;
  /** How many HTTP requests the probe spent reaching this verdict. */
  readonly requests: number;
}

/**
 * The verdicts that mean "this route can run a turn". Everything else
 * is either a failure or an open question, and neither may be reported
 * as proven compatibility.
 *
 * Two of them qualify, because a turn is a narrower thing than the
 * probe's primary instrument. `step-executor` sends
 * `tool_choice: "auto"` on every request and never a forced or named
 * choice — deliberately, with production-observed reasons written down
 * beside it (Alibaba's Qwen-thinking gate answers `400 InvalidParameter`
 * to a forced choice at all). A route that refuses the forcing and then
 * streams a complete native tool call under `auto` therefore runs every
 * real Atomic turn correctly, and calling it unproven would warn
 * operators who are not hitting any bug. The forced rung stays first
 * because it is the only mode in which "no tool call" is a statement
 * about the route rather than about the model's mood.
 */
export function contractProbeProvesToolSupport(
  status: ProviderContractStatus,
): boolean {
  return status === "tools_supported" || status === "forced_tool_choice_rejected";
}

/**
 * The synthetic function definition, in the exact shape
 * `buildOpenAiChatBody` puts real tools in, so a route that validates
 * tool schemas judges this one by the same rules it will judge Atomic's.
 *
 * No required properties: a model answering a forced call with empty
 * arguments is honoring the contract, and demanding a field would turn
 * that legal answer into a false "malformed" verdict.
 */
export function contractProbeToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: CONTRACT_PROBE_TOOL_NAME,
      description:
        "Diagnostic no-op used to check that this endpoint can emit a native tool call. Has no effect.",
      parameters: {
        type: "object",
        properties: {
          ok: {
            type: "boolean",
            description: "Always true.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}
