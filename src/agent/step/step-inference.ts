import type { StepContext, StepDependencies, LlmStreamParams } from "./step-contract.js";
import { getConfig } from "../../config/index.js";
import { NO_SERVER_TEMPLATE, resolveServerTemplatePolicy, thinkingDisabledOnBuiltPrompt } from "../../llm/server-template-policy.js";
import { promptCarriesReasoningPrefill, memoizeText, resolveReasoning, completionAssumesOpenReasoning } from "./step-reasoning.js";
import { descriptorsForRole } from "../../tools/tool-roles.js";
import { narrowDescriptorsToToolSet, toolSetAdmits } from "../policies/step-tool-set.js";
import type { BuildPromptInput } from "../../prompt/build-prompt-types.js";
import { formatCurrentDate } from "../../prompt/current-date.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import { hashPrefix } from "../../llm/slot-manager.js";
import { checkProfilePromptAligned } from "../../llm/profile-invariants.js";
import type { BuiltPrompt } from "../../prompt/build-prompt.js";
import type { CompletionResult, StreamChunk } from "../../llm/llama-server-client.js";
import { estimateReasoningTokens } from "../../llm/reasoning-budget.js";
import { parseDepsFor } from "./step-parsing.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { refusedToolNames } from "../policies/fusion-orchestrator-mode.js";
import { withoutReasoningPrelude, withUnboundedReasoningPrelude } from "../../llm/grammar/reasoning-prelude.js";
import { buildGrammarForTools } from "../../llm/grammar/build-grammar.js";
import type { PromptMessages, ToolCallTransport } from "../../llm/provider/completion-types.js";
import { openAiToolCallAdapter } from "../../llm/provider/openai/openai-tool-call-adapter.js";
import { hasStrictFunctionTools } from "../../llm/provider/adapters/tool-call-adapter.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { StepEvent } from "../step-events.js";
import type { StreamParser, StreamParseEvent } from "../../llm/grammar/stream-parser.js";
import { createStreamParser } from "../../llm/grammar/stream-parser.js";
import { reasoningOpenEmittedByModel } from "../../llm/model-profile.js";
import { estimateTokens } from "../../prompt/token-budget.js";
import { assertContextCapacity } from "../../llm/provider/context-capacity.js";
export function prepareStepPrompt(ctx: StepContext, deps: StepDependencies) {
  // Whether this step's local prompt goes through the model's own chat
  // template. The template supplies the turn markers and the reasoning
  // prelude, so the prompt is built framing-free, like a chat-transport
  // prompt (F31).
  const localModels = getConfig().localModels;
  const serverTemplate =
    deps.toolTransport === "native_tools"
      ? NO_SERVER_TEMPLATE
      : resolveServerTemplatePolicy(localModels, deps.profile);
  const promptCarriesPrefill =
    !serverTemplate.useServerTemplate &&
    promptCarriesReasoningPrefill(deps.profile, deps.toolTransport);
  // `localModels.thinking: "off"` on the hand-built prompt path (F49):
  // the prompt ends with the template's disabled marker, the request
  // grammar has no prelude, and the completion is parsed as starting
  // outside a think block. Keyed off the profile and the switch, not the
  // transport, so a native-tools primary's grammar fallback link gets the
  // same pairing through `grammarPrompt`. The template path has its own
  // switch (`chat_template_kwargs`) and is left to it.
  const thinkingOff =
    !serverTemplate.useServerTemplate &&
    thinkingDisabledOnBuiltPrompt(localModels.thinking, deps.profile);
  // The same catalog on every step, the final one included: `### tools`
  // is stable-prefix bytes, and a catalog narrowed to reply/finish for
  // the last step re-read the whole prompt on a cold slot. The final
  // step is enforced by the batch gate and, locally, by the grammar
  // (`resolveStepGrammar`), never by the catalog.
  const stepToolDescriptors = ctx.toolDescriptors;
  // What this step describes in full, puts on the native wire and admits
  // in the grammar: the role's tools plus the ones the session has loaded
  // through `tool.view`. Under `full` this IS `stepToolDescriptors`, same
  // array — the adapter's memo keys on identity.
  const loadedToolNames = new Set(
    (ctx.session.loadedTools ?? []).map((t) => t.name),
  );
  const roleToolDescriptors = descriptorsForRole(
    ctx.toolRole,
    stepToolDescriptors,
    loadedToolNames,
  );
  // A per-step tool set narrows what goes on the native wire and into
  // the grammar below the role's list. One array feeds the request AND
  // the parser (the adapter memoises on identity), and the batch gate
  // gets the same names — see `step-tool-set.ts`.
  const stepDescriptors =
    ctx.toolSet !== undefined
      ? narrowDescriptorsToToolSet(roleToolDescriptors, ctx.toolSet)
      : roleToolDescriptors;
  const promptInput: BuildPromptInput = {
    session: ctx.session,
    toolDescriptors: stepToolDescriptors,
    capabilities: ctx.capabilities,
    skillCatalog: ctx.skillCatalog,
    ...(ctx.skillCatalogDropped !== undefined
      ? { skillCatalogDropped: ctx.skillCatalogDropped }
      : {}),
    currentDate: formatCurrentDate(new Date()),
    profile: deps.profile,
    ...(deps.modelMode ? { modelMode: deps.modelMode } : {}),
    ...(deps.modelMode?.mode === "cloud" ? {
      completionMaxTokens: ctx.maxTokens ?? ctx.maxOutputTokens ?? localModels.completionMaxTokens,
      toolSchemaTokens: deps.toolTransport === "native_tools"
        ? estimateTokens(JSON.stringify((deps.toolCallAdapter ?? openAiToolCallAdapter).descriptorsToTools(stepDescriptors, { strict: deps.strictTools === true }))) : 0,
    } : {}),
    ...(ctx.toolRole !== undefined ? { toolRole: ctx.toolRole } : {}),
    fusionTokensPerSecond: deps.fusionTokensPerSecond?.() ?? null,
    // The prefix must match the request shape: a native-tools link gets
    // native function-calling guidance instead of the text-JSON array
    // mandate (issue #285). Configured transport, not `servedTransport`:
    // the prompt is built before any fallback link serves the request.
    ...(deps.toolTransport !== undefined
      ? { toolTransport: deps.toolTransport }
      : {}),
    // Chat providers apply their own template server-side; a literal
    // reasoning prefill there is at best echoed noise and at worst
    // corrupted in transit (Ollama Cloud, ollama/ollama#17248). The
    // same holds for a local link rendering through its own template.
    suppressReasoningPrefill:
      deps.toolTransport === "native_tools" || serverTemplate.useServerTemplate,
    thinking: localModels.thinking,
    ...(deps.contextWindow !== undefined
      ? { contextWindow: deps.contextWindow }
      : {}),
    ...(deps.profileWindowApplies !== undefined
      ? { profileWindowApplies: deps.profileWindowApplies }
      : {}),
    ...(deps.liveWorkerSlots !== undefined
      ? { liveWorkerSlots: deps.liveWorkerSlots() }
      : {}),
    ...(ctx.transientNotice !== undefined
      ? { transientNotice: ctx.transientNotice }
      : {}),
    ...(ctx.profileFacts !== undefined
      ? { profileFacts: ctx.profileFacts }
      : {}),
    ...(ctx.userMessage !== undefined ? { userMessage: ctx.userMessage } : {}),
    ...(ctx.originalRequest !== undefined
      ? { originalRequest: ctx.originalRequest }
      : {}),
    ...(ctx.routeNote !== undefined ? { routeNote: ctx.routeNote } : {}),
  };
  return { promptInput, thinkingOff, promptCarriesPrefill, serverTemplate, stepDescriptors, stepToolDescriptors };
}

export function prepareStepInference(ctx: StepContext, deps: StepDependencies) {
  const { promptInput, thinkingOff, promptCarriesPrefill, serverTemplate, stepDescriptors, stepToolDescriptors } = prepareStepPrompt(ctx, deps);
  const prompt = buildPrompt(promptInput);
  if (prompt.cloudContext) ctx.session = { ...ctx.session, cloudContext: prompt.cloudContext };
  // A grammar (llama-server) fallback link behind a native-tools primary
  // still needs the legacy prefill-carrying prompt shape — its template
  // and GBNF prelude expect the reasoning open tag / turn framing at the
  // generation point, which the main prompt above deliberately dropped.
  // Lazy + memoized: the second build only runs if the fallback seam
  // actually routes this request to a grammar link (sticky-fallover
  // turns included). See `LlmStreamParams.grammarPrompt`.
  const grammarPrompt =
    deps.toolTransport === "native_tools" &&
    deps.profile.requiresPromptThinkPrefix
      ? memoizeText(
          () =>
            buildPrompt({
              ...promptInput,
              // The grammar link's template/GBNF prelude also expects the
              // legacy text-JSON emission mandate, not the native
              // function-calling guidance the primary prompt carries
              // (issue #285) — rebuild for the grammar transport.
              toolTransport: "grammar",
              suppressReasoningPrefill: false,
            }).text,
        )
      : undefined;
  const slot = deps.supportsSlotAffinity
    ? deps.slotManager.acquire(ctx.session.id, prompt.stablePrefix)
    : {
        slotId: -1,
        prefixHash: hashPrefix(prompt.stablePrefix),
        firstSeenAt: Date.now(),
        cacheReused: false,
        pending: false,
      };
  if (ctx.stepIndex === 0) {
    const promptViolations = checkProfilePromptAligned(
      deps.profile,
      prompt.text,
      {
        promptCarriesPrefill,
        thinkingDisabled: thinkingOff,
      },
    );
    if (promptViolations.length > 0) {
      deps.logger?.warn("profile/prompt invariant violated", {
        profile: deps.profile.id,
        sessionId: ctx.session.id,
        violations: promptViolations,
      });
    }
  }
  deps.onEvent?.({ type: "prompt_built", prompt, slotId: slot.slotId });
  deps.onEvent?.({
    type: "prompt_captured",
    stepIndex: ctx.stepIndex,
    stablePrefixHash: hashPrefix(prompt.stablePrefix),
    tail: prompt.tail,
    tokens: {
      total: prompt.tokens.total,
      stablePrefix: prompt.tokens.stablePrefix,
      tail: Math.max(0, prompt.tokens.total - prompt.tokens.stablePrefix),
    },
    slotId: slot.slotId,
    cacheReused: slot.cacheReused,
  });
  deps.logger?.debug("prompt built", {
    sessionId: ctx.session.id,
    slotId: slot.slotId,
    cacheReused: slot.cacheReused,
    promptTokens: prompt.tokens.total,
  });

  // The cap every completion of this step runs under. Named here so the
  // failure detector can say which wall a cut-off reply hit.
  const replyCap =
    ctx.maxTokens ??
    ctx.maxOutputTokens ??
    getConfig().localModels.completionMaxTokens;
  // The grammar for THIS request. Narrowed below the base grammar only
  // when the step has fewer tools than the catalog (the final step, an
  // orchestrator turn, a filtered worker); otherwise the base grammar
  // goes out byte-identical. The prompt is not touched either way — the
  // grammar rides with the request, outside the KV-cached prefix.
  const stepGrammar = resolveStepGrammar(
    ctx,
    deps,
    stepDescriptors,
    thinkingOff,
  );
  const llmParams: LlmStreamParams = {
    ...(prompt.contextBudget ? { contextBudget: prompt.contextBudget } : {}),
    ...buildLlmStreamParams({
      promptText: prompt.text,
      promptMessages: prompt.messages,
      deps,
      grammar: stepGrammar,
      slotId: slot.slotId,
      sessionId: ctx.session.id,
      toolDescriptors: stepDescriptors,
      // The request's own signal: the user's abort composed with the
      // task's remaining time (F15). Tools keep running on `ctx.signal`
      // alone — the ceiling ends the request, the loop ends the task.
      signal: ctx.requestSignal ?? ctx.signal,
    }),
    // On a slot-affine link the prompt is always worth caching — a
    // pending `-1` with `cache_prompt: true` is what lets llama-server
    // pick the slot by prefix similarity and keep the prompt there.
    ...(deps.supportsSlotAffinity ? { cachePrompt: true } : {}),
    ...(grammarPrompt ? { grammarPrompt } : {}),
    ...(serverTemplate.useServerTemplate
      ? {
          chat: {
            system: prompt.stablePrefix,
            user: prompt.tail,
            prefixHash: slot.prefixHash,
            ...(serverTemplate.enableThinking !== undefined
              ? { enableThinking: serverTemplate.enableThinking }
              : {}),
          },
        }
      : {}),
    ...(ctx.maxTokens !== undefined ? { maxTokens: ctx.maxTokens } : {}),
    // The turn's own settings ride on every completion of the step; the
    // repair retry spreads `llmParams`, so they inherit without a second
    // wiring point.
    ...(ctx.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.maxOutputTokens }
      : {}),
    ...(ctx.reasoningEffort !== undefined
      ? { reasoningEffort: ctx.reasoningEffort }
      : {}),
  };
  if (deps.modelModePolicy) {
    llmParams.prepareForLink = (link) => {
      const template = link.transport === "native_tools" ? NO_SERVER_TEMPLATE
        : resolveServerTemplatePolicy(getConfig().localModels, deps.profile);
      const next = buildPrompt({ ...promptInput, session: ctx.session, modelMode: link.modelMode,
        toolTransport: link.transport, contextWindow: link.contextWindow, profileWindowApplies: false,
        suppressReasoningPrefill: link.transport === "native_tools" || template.useServerTemplate,
        completionMaxTokens: link.maxTokens ?? ctx.maxOutputTokens ?? getConfig().localModels.completionMaxTokens,
      });
      if (next.cloudContext) ctx.session = { ...ctx.session, cloudContext: next.cloudContext };
      deps.onEvent?.({ type: "prompt_built", prompt: next, slotId: slot.slotId });
      if (next.contextBudget) assertContextCapacity(next.text + JSON.stringify(llmParams.tools ?? []), next.contextBudget);
      return { prompt: next.text, messages: next.messages, contextBudget: next.contextBudget,
        ...(template.useServerTemplate ? { chat: { system: next.stablePrefix, user: next.tail,
          prefixHash: hashPrefix(next.stablePrefix), enableThinking: template.enableThinking } } : { chat: undefined }) };
    };
  }
  if (prompt.contextBudget) assertContextCapacity(prompt.text + JSON.stringify(llmParams.tools ?? []), prompt.contextBudget);
  return { prompt, slot, replyCap, stepDescriptors, stepToolDescriptors, grammarPrompt, promptCarriesPrefill, thinkingOff, llmParams };
}

export type PreparedStepInference = ReturnType<typeof prepareStepInference>;



export interface InitialCompletionArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prompt: BuiltPrompt;
  slot: { slotId: number; cacheReused: boolean };
  llmParams: LlmStreamParams;
  /** `thinking: off` honoured on this step's built prompt (F49). */
  thinkingOff: boolean;
}


/**
 * Run the first LLM call for a step (stream path when available, unary
 * fallback otherwise) and emit the matching observability events.
 */
export async function runInitialCompletion(
  args: InitialCompletionArgs,
): Promise<{ completion: CompletionResult }> {
  const { ctx, deps, prompt, slot, llmParams, thinkingOff } = args;
  const startedAt = Date.now();
  const completion = deps.llmCompleteStream
    ? await consumeStream(
        deps.llmCompleteStream(llmParams),
        ctx.stepIndex,
        deps.profile,
        deps.toolTransport,
        thinkingOff,
        deps.onEvent,
      )
    : await deps.llmComplete(llmParams);
  const durationMs = Date.now() - startedAt;
  // How much of the completion was thinking, in the budget's units, so
  // a trace shows a step that hit `localModels.reasoningBudgetTokens`
  // (`reasoningTokens >= budget`). Same extraction the reasoning event
  // below uses, keyed off the link that served the completion.
  const reasoningTokens = estimateReasoningTokens(
    resolveReasoning(
      completion,
      deps.profile,
      completionAssumesOpenReasoning(
        deps.profile,
        parseDepsFor(completion, deps).toolTransport,
        thinkingOff,
      ),
    ),
  );
  deps.onCompletion?.(completion);
  deps.onEvent?.({ type: "llm_completed", completion });
  deps.onEvent?.({
    type: "llm_raw_completion",
    stepIndex: ctx.stepIndex,
    attempt: 1,
    completion,
    reasoningTokens,
  });
  deps.metrics?.recordLlmCall({
    sessionId: ctx.session.id,
    promptTokens: completion.timing?.promptTokens ?? prompt.tokens.total,
    completionTokens: completion.timing?.predictedTokens ?? 0,
    durationMs,
    cacheReused: slot.cacheReused,
  });
  return { completion };
}


/** The two terminal verbs — the only names the final step may emit. */
export const TERMINAL_TOOL_NAMES: readonly string[] = ["reply", "finish"];


/**
 * The tool names this step's grammar admits, or `null` when nothing
 * narrows it and the base grammar should go out untouched.
 *
 * Narrowing, in order of precedence:
 *  - the final step (`terminalOnly`) admits `reply` and `finish` only;
 *  - a per-step tool set (`toolSet`) admits its names only — the
 *    descriptors handed in are already narrowed to them, so the filter
 *    is a guard; what matters is that the grammar is rebuilt;
 *  - a fusion ORCHESTRATOR turn drops every name the gate would refuse
 *    (`wouldRefuse`) — the model keeps the descriptors and loses the
 *    ability to spend a step on a call that ends in a refusal;
 *  - a turn with a `toolFilter` (a fusion worker) drops what the filter
 *    hides, `finish` included.
 * The candidate set is the step's own descriptor list (`reply` and
 * `finish` are descriptors too), so the grammar can never admit a name
 * the prompt does not describe. The base grammar stays in charge of any
 * unrestricted step: its grouped rules are what the static grammar tests
 * pin, and a step that narrows nothing has no reason to rewrite them.
 */
export function stepGrammarToolNames(
  ctx: Pick<
    StepContext,
    "terminalOnly" | "toolSet" | "toolFilter" | "toolRole"
  >,
  deps: Pick<StepDependencies, "registry" | "isFusionOrchestrator">,
  descriptors: readonly ToolDescriptor[],
): readonly string[] | null {
  if (ctx.terminalOnly) return TERMINAL_TOOL_NAMES;
  let names = descriptors.map((d) => d.name);
  // A role other than `full` has already narrowed `descriptors` to the
  // role's tools plus the loaded ones (`descriptorsForRole`); the grammar
  // must follow, or the sampler could still emit what the prompt no
  // longer describes in full.
  let restricted = ctx.toolRole !== undefined && ctx.toolRole !== "full";
  if (ctx.toolSet !== undefined) {
    const set = ctx.toolSet;
    names = names.filter((name) => toolSetAdmits(set, name));
    restricted = true;
  }
  if (deps.isFusionOrchestrator?.()) {
    const refused = refusedToolNames(names, { registry: deps.registry });
    if (refused.size > 0) {
      names = names.filter((name) => !refused.has(name));
      restricted = true;
    }
  }
  if (ctx.toolFilter) {
    const filter = ctx.toolFilter;
    names = names.filter((name) => filter(name));
    restricted = true;
  }
  return restricted ? names : null;
}


/**
 * The grammar for THIS request. The reasoning prelude first (F49): gone
 * under `thinking: off` (the prompt ends with the template's disabled
 * marker, so the completion starts on the call); unbounded on the forced
 * final step — a `reply` / `finish` is never cut mid-thought; the base
 * grammar's configured bound (`localModels.reasoningBudgetTokens`)
 * otherwise. Then the tool names (`stepGrammarToolNames`). An
 * unrestricted, non-final step under `thinking: on|auto` sends the base
 * grammar byte-identical.
 */
export function resolveStepGrammar(
  ctx: Pick<
    StepContext,
    "terminalOnly" | "toolSet" | "toolFilter" | "toolRole"
  >,
  deps: Pick<StepDependencies, "registry" | "isFusionOrchestrator" | "grammar">,
  descriptors: readonly ToolDescriptor[],
  thinkingOff: boolean,
): string {
  const base = thinkingOff
    ? withoutReasoningPrelude(deps.grammar)
    : ctx.terminalOnly
      ? withUnboundedReasoningPrelude(deps.grammar)
      : deps.grammar;
  const names = stepGrammarToolNames(ctx, deps, descriptors);
  return names === null ? base : buildGrammarForTools(base, names);
}


export function buildLlmStreamParams(args: {
  promptText: string;
  promptMessages?: PromptMessages;
  deps: Pick<
    StepDependencies,
    | "toolTransport"
    | "toolCallAdapter"
    | "supportsParallelTools"
    | "strictTools"
    | "providerId"
    | "modelModePolicy"
  >;
  /** The grammar for this request — see `resolveStepGrammar`. */
  grammar: string;
  slotId: number;
  sessionId: string;
  toolDescriptors: readonly ToolDescriptor[];
  signal?: AbortSignal;
}): LlmStreamParams {
  const base: LlmStreamParams = {
    prompt: args.promptText,
    grammar: args.grammar,
    slotId: args.slotId,
    sessionId: args.sessionId,
    ...(args.deps.modelModePolicy ? { modelModePolicy: args.deps.modelModePolicy } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    // The pin rides on every completion of the step: the repair retry
    // spreads `llmParams`, so it inherits without a second wiring point.
    ...(args.deps.providerId ? { providerId: args.deps.providerId } : {}),
  };
  if (args.deps.toolTransport !== "native_tools") {
    return base;
  }
  const adapter = args.deps.toolCallAdapter ?? openAiToolCallAdapter;
  const tools = adapter.descriptorsToTools(args.toolDescriptors, {
    strict: args.deps.strictTools === true,
  });
  return {
    ...base,
    // The structured prompt rides only on the native path; the seam
    // forwards it only to a native link (`llm-link-attempt.ts`).
    ...(args.promptMessages ? { messages: args.promptMessages } : {}),
    // Keep `grammar` populated (not blanked) even on the native path: the
    // provider fallback chain may hand this request to a grammar-only
    // llama-server link, which needs the GBNF. Native (cloud) providers
    // ignore `grammar` entirely and read `tools`, so carrying both makes
    // the request valid for whichever link actually serves it.
    tools,
    // `auto` instead of `required`. Three production-observed reasons:
    //   * Qwen-thinking providers (Alibaba gate) reject `required` outright
    //     with `<400> InvalidParameter: tool_choice does not support being
    //     set to required or object in thinking mode`.
    //   * GLM-5-thinking under `required` dumps the user-facing body into
    //     `reasoning_content` and emits a hollow `reply { text: "<one-line
    //     prelude>" }` just to satisfy the contract — the rest of the
    //     answer is lost from the assistant turn.
    //   * Weak non-thinking models (e.g. deepseek-v4-flash) hallucinate a
    //     `memory.notes.recall {}` (or similar) just to "say something"
    //     when `required` is on, and then loop on the validation error.
    // Under `auto` the model can return plain `content` instead. The
    // step-executor's `tryParseToolCalls` synthesises a `reply` call from
    // that content (see invariant comment there), so the
    // one-inference-per-step contract is preserved.
    toolChoice: "auto",
    // Ask the provider for a single tool call per response unless the
    // executor cap allows more AND the provider reports it can emit
    // parallel calls. With `maxParallelToolCalls=1` this is the
    // provider-compatibility control: some OpenAI-compatible streams
    // (Gemini) lack stable indices for parallel calls, so the setting
    // must reach the wire, not just the executor's batch planner
    // (issue #104).
    //
    // A request carrying strict tools has a third veto, and it is not
    // optional: OpenAI states that Structured Outputs is not compatible
    // with parallel function calls — "when a parallel function call is
    // generated, it may not match supplied schemas" — and says to set
    // `parallel_tool_calls: false`. Leaving it at `true` would mark
    // every convertible tool `strict` and still get best-effort
    // adherence, which is the exact symptom this feature exists to
    // cure, so the operator who turns strict on gets one tool call per
    // response on the wire. (Credit: the parallel work on #402 found
    // this; this branch had missed it.) The executor's own
    // `maxParallelToolCalls` batching is untouched — a model that
    // emits several calls anyway is still planned and run the same way.
    //
    // Keyed to the emitted array, not to `deps.strictTools`: strict is
    // granted per tool, and an adapter that ignored the option, or a
    // descriptor set where nothing converted, must not silently lose
    // parallel calls for a request that is not constrained at all.
    parallelToolCalls:
      !hasStrictFunctionTools(tools) &&
      getConfig().agent.maxParallelToolCalls > 1 &&
      (args.deps.supportsParallelTools ?? true),
  };
}


/**
 * Drain the SSE generator, feeding each token delta to the grammar-aware
 * stream parser and relaying its emissions as `StepEvent`s. The generator's
 * terminal return value carries the final `CompletionResult` (timings,
 * cached-tokens, model id), so callers still receive the unary contract.
 *
 * If the generator finishes without emitting a `done` frame (old
 * llama-server builds, truncated network response), we fall back to a
 * synthetic `CompletionResult` populated from the accumulated buffer so
 * the downstream parser still has something to work with.
 */
export async function consumeStream(
  stream: AsyncGenerator<StreamChunk, CompletionResult, void>,
  stepIndex: number,
  profile: ModelProfile,
  primaryTransport: ToolCallTransport,
  thinkingOff: boolean,
  onEvent?: (event: StepEvent) => void,
): Promise<CompletionResult> {
  // The parser's pre-opened state depends on which link SERVES the
  // stream, not on the configured primary: a native-tools primary that
  // fell over to a grammar local link streams GBNF output that starts
  // mid-`<think>` (the fallback seam stamps `servedTransport` on every
  // chunk precisely so this is knowable live — the final result's stamp
  // arrives only after the last delta, too late to classify reasoning).
  // Created lazily on the first chunk; unstamped chunks (direct,
  // non-fallback path) key off the primary transport. With model-emitted
  // reasoning (Gemma 4 turn-framing) the parser must always detect the
  // open tag live in the stream instead.
  let servedTransport: ToolCallTransport | undefined;
  let parser: StreamParser | null = null;
  const getParser = (): StreamParser => {
    parser ??= createStreamParser({
      preOpenedThink:
        completionAssumesOpenReasoning(
          profile,
          servedTransport ?? primaryTransport,
          thinkingOff,
        ) && !reasoningOpenEmittedByModel(profile),
      ...(profile.reasoningStyle !== "none"
        ? {
            reasoningOpenTag: profile.reasoningOpenTag,
            reasoningCloseTag: profile.reasoningCloseTag,
          }
        : {}),
    });
    return parser;
  };
  let accumulated = "";
  // Channel A (server-side `reasoning_content` SSE deltas: QwQ /
  // DeepSeek-R1 with `--reasoning-format deepseek`) is mutually exclusive
  // with channel B (inline `<think>...</think>` / `<|channel>thought` text
  // that the grammar-aware stream parser splits out client-side). We
  // accumulate them separately so the legacy `/completion` path (where
  // channel A is always empty) still ends up with a populated
  // `reasoningContent` field for traces + `resolveReasoning` callers,
  // without risking double-count when a server happens to emit both.
  let channelAReasoning = "";
  let parserReasoning = "";
  const emitParseEvents = (events: readonly StreamParseEvent[]): void => {
    for (const ev of events) {
      if (ev.kind === "reasoning_delta") {
        parserReasoning += ev.text;
        onEvent?.({ type: "reasoning_delta", stepIndex, text: ev.text });
      } else if (ev.kind === "reply_text_delta") {
        onEvent?.({ type: "assistant_delta", text: ev.text });
      }
    }
  };
  let finalResult: CompletionResult | null = null;
  // Whether this loop reached the generator's own `done`. A loop that
  // did not has abandoned a LIVE stream, and an abandoned stream that is
  // never closed is never released: `LlamaServerClient.completeStream`
  // tears its socket down in a `finally`, and a `finally` only runs on a
  // generator someone closes. A `for await` would call `.return()` for
  // us on the way out; this hand-run loop has to do it itself, or the
  // exception that ends it — a parser throw, an `onEvent` consumer
  // throwing back at us — leaves a llama.cpp slot held by a request no
  // log mentions and every later completion queues behind, for the life
  // of the process. This is the one abandon site the release exists for.
  let drained = false;
  try {
    while (true) {
      const next = await stream.next();
      if (next.done) {
        finalResult = next.value;
        break;
      }
      const chunk = next.value;
      // Latch the serving link's transport off the first stamped chunk —
      // it is constant for the whole stream (a live stream is never
      // restarted on another link) and must be known before the parser is
      // first used.
      servedTransport ??= chunk.servedTransport;
      // Channel A: dedicated `reasoning_content` deltas (QwQ, DeepSeek-R1
      // with `--reasoning-format deepseek`). Bypass the grammar parser —
      // these tokens never appear inside `<think>` or JSON, they come on a
      // separate SSE field and are already decoded.
      if (chunk.reasoningDelta && chunk.reasoningDelta.length > 0) {
        channelAReasoning += chunk.reasoningDelta;
        onEvent?.({
          type: "reasoning_delta",
          stepIndex,
          text: chunk.reasoningDelta,
        });
      }
      // Channel B: inline content (may contain `<think>...</think>` +
      // grammar-constrained JSON). The stream parser splits this into
      // reasoning / reply-text deltas for us.
      if (chunk.delta.length > 0) {
        accumulated += chunk.delta;
        emitParseEvents(getParser().push(chunk.delta));
      }
      if (chunk.done) {
        // Some servers close the iterator right after the done frame; keep
        // draining until `next.done` so we do not leave the response reader
        // hanging.
      }
    }
    drained = true;
  } finally {
    // Only on the abandon: a stream driven to `done` has closed itself.
    // Swallowed and awaited-with-a-catch because we are already
    // unwinding — the release must not replace the error that ended this
    // loop with one of its own.
    if (!drained) {
      await stream.return(undefined as never).catch(() => undefined);
    }
  }
  emitParseEvents(getParser().end());
  // Prefer server-emitted channel A reasoning when present; otherwise
  // fall back to the parser-derived stream (legacy `/completion`
  // endpoint, which never sets `reasoning_content` server-side).
  const accumulatedReasoning =
    channelAReasoning.length > 0 ? channelAReasoning : parserReasoning;
  if (finalResult === null) {
    finalResult = {
      content: accumulated,
      reasoningContent: accumulatedReasoning,
      stop: true,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 0,
        predictedTokens: 0,
      },
      cacheHitTokens: 0,
      slotId: -1,
      modelId: null,
    };
  } else {
    const patch: Partial<CompletionResult> = {};
    if (finalResult.content.length === 0 && accumulated.length > 0) {
      patch.content = accumulated;
    }
    const existingReasoning =
      typeof finalResult.reasoningContent === "string"
        ? finalResult.reasoningContent
        : "";
    if (existingReasoning.length === 0 && accumulatedReasoning.length > 0) {
      patch.reasoningContent = accumulatedReasoning;
    }
    if (Object.keys(patch).length > 0) {
      finalResult = { ...finalResult, ...patch };
    }
  }
  return finalResult;
}
