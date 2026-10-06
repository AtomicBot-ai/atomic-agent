import type { ToolCallBatch } from "../../llm/grammar/tool-call-grammar.js";
import type { StepDependencies, StepContext, LlmStreamParams } from "./step-contract.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { completionAssumesOpenReasoning, resolveReasoning, normalizeContent, getReasoningTagOptions, memoizeText } from "./step-reasoning.js";
import { openAiToolCallAdapter } from "../../llm/provider/openai/openai-tool-call-adapter.js";
import { parseToolCalls, extractReasoning } from "../../llm/grammar/tool-call-grammar.js";
import { BatchValidationError } from "./step-errors.js";
import { getReasoningTurnFraming } from "../../llm/model-profile.js";
import type { BuiltPrompt } from "../../prompt/build-prompt.js";
import { estimateReasoningTokens } from "../../llm/reasoning-budget.js";
import { detectModelFailure, ModelError } from "../../llm/index.js";


export type ToolCallBatchParseResult =
  { ok: true; batch: ToolCallBatch } | { ok: false; error: Error };


export function isNativeToolsEmptyCompletionHandledByParser(
  deps: Pick<StepDependencies, "toolTransport">,
  reason: string,
  completion: CompletionResult,
): boolean {
  if (deps.toolTransport !== "native_tools" || reason !== "empty") {
    return false;
  }
  // Empty `content` is OK when the model still emitted at least one
  // OpenAI `tool_call` — the parser can recover those.
  if (completion.toolCalls !== undefined && completion.toolCalls.length > 0) {
    return true;
  }
  // Reasoning-only completions (Qwen3.8 with preserve_thinking,
  // DeepSeek-R1 over OpenAI-compatible APIs): the model ends its turn
  // with all text in `reasoning_content`, `content` empty and no
  // tool_calls. The parser gets a crack at these: a GBNF-shaped batch
  // inside the reasoning is recovered as real tool calls; anything else
  // fails the parse and routes through the one-shot repair (never as a
  // raw-CoT `reply` — issue #285). Only a completion with NOTHING in
  // any channel routes through ModelError.
  const reasoning =
    typeof completion.reasoningContent === "string"
      ? completion.reasoningContent.trim()
      : "";
  return reasoning.length > 0;
}


/**
 * The cap the one-shot repair completion runs under.
 *
 * `REPAIR_MAX_TOKENS` is a grammar-link guard: the repair prompt strips
 * the reasoning prefill there, which keeps the think block short, and
 * the cap stops a self-deliberation loop from holding a llama-server
 * slot for minutes. On `native_tools` neither premise holds — the chat
 * template opens the think block server-side and there is no slot — so
 * a reasoning model routinely needs more than 1024 tokens just to reach
 * the tool call, and the cap turned every repair into a truncation.
 * The step's own cap bounds it instead, the same bound as the first
 * completion.
 */
export function repairReplyCap(transport: ToolCallTransport, stepCap: number): number {
  return transport === "native_tools" ? stepCap : REPAIR_MAX_TOKENS;
}


/**
 * Is this an empty completion the one-shot repair should get a crack at?
 *
 * On the grammar transports an empty body is not the dead end
 * `detectModelFailure`'s doc assumes. The prompt is not replayed
 * verbatim: the repair path rebuilds it through
 * `buildToolCallRepairPrompt` with a corrective notice and a bounded
 * token cap, which is a materially different request — and the same
 * machinery already recovers every *other* unparseable body (a truncated
 * array, a stray prelude, prose where JSON belongs). Only "the model
 * emitted literally nothing" was singled out to end the turn outright,
 * and that is the single largest failure bucket in production.
 *
 * `native_tools` is deliberately excluded: that transport has its own
 * salvage path (`isNativeToolsEmptyCompletionHandledByParser`), and a
 * native completion with nothing in any channel routes through
 * `ModelError` by design — see `step-executor.test.ts`, "native_tools:
 * routes 'no tool_calls and no content' through ModelError".
 *
 * `truncated` and `no_stop` are excluded too, and for the original
 * reason: the model already spent its budget on this prefix, so a second
 * pass hits the same wall.
 */
export function isGrammarEmptyCompletionWorthRepairing(
  deps: Pick<StepDependencies, "toolTransport">,
  reason: string,
): boolean {
  return reason === "empty" && deps.toolTransport !== "native_tools";
}


/**
 * Effective transport for *parsing a response*. Prefers the transport of
 * the provider that actually served the completion (`servedTransport`,
 * stamped by the fallback chain wrapper) over the caller's configured
 * `toolTransport`. They differ on a cross-transport fallover — e.g. a
 * native-tools cloud primary that fell over to a grammar-only local link:
 * the request went out grammar-shaped, so the response must be parsed as
 * grammar, not as OpenAI `tool_calls`. Absent `servedTransport` (the
 * direct, non-wrapped path), the configured transport is authoritative.
 */
export type ParseDeps = Pick<
  StepDependencies,
  "toolTransport" | "toolCallAdapter" | "strictTools"
>;


export function parseDepsFor(
  completion: CompletionResult,
  deps: ParseDeps,
): ParseDeps {
  const served = completion.servedTransport;
  if (served === undefined || served === deps.toolTransport) return deps;
  return {
    toolTransport: served,
    // A grammar link needs no adapter; a native link uses the default
    // OpenAI adapter unless the caller carried a custom one for it.
    toolCallAdapter: served === "native_tools" ? deps.toolCallAdapter : null,
    ...(deps.strictTools !== undefined
      ? { strictTools: deps.strictTools }
      : {}),
  };
}


/**
 * Non-throwing parser wrapper. The step executor uses it to distinguish
 * a malformed first attempt (retryable) from any other error shape.
 * Returns a `ToolCallBatch` that may carry a single call (legacy
 * shape) or N calls in batch-index order.
 */
export function tryParseToolCalls(
  completion: CompletionResult,
  profile: ModelProfile,
  deps: ParseDeps,
  // The descriptor list the REQUEST was built from: the strict-marked
  // names have to be derived from the same input, or the undo on the
  // way in stops matching the rewrite on the way out.
  toolDescriptors: readonly ToolDescriptor[],
  thinkingOff: boolean,
): ToolCallBatchParseResult {
  const assumeOpenReasoning = completionAssumesOpenReasoning(
    profile,
    deps.toolTransport,
    thinkingOff,
  );
  try {
    if (deps.toolTransport === "native_tools") {
      if (completion.toolCalls && completion.toolCalls.length > 0) {
        const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
        const reasoning = resolveReasoning(
          completion,
          profile,
          assumeOpenReasoning,
        );
        // Per ARGUMENT, not per batch and not even per tool: only the
        // arguments this adapter moved from optional into `required`
        // carry a `null` the schema put there, so only those get the
        // rewrite undone. The map comes from the same adapter and the
        // same descriptor list the request was built from.
        const strictWidenedArgs =
          deps.strictTools === true && adapter.strictWidenedArgs
            ? adapter.strictWidenedArgs(toolDescriptors, { strict: true })
            : undefined;
        const batch = adapter.toolCallsToBatch(
          completion.toolCalls,
          reasoning,
          {
            ...(strictWidenedArgs ? { strictWidenedArgs } : {}),
          },
        );
        if (batch.calls.length === 0) {
          return {
            ok: false,
            error: new Error("native tool_calls array was empty after mapping"),
          };
        }
        return { ok: true, batch };
      }
      // No `tool_calls`, plain `content`. Two recovery paths, in order:
      //
      // 1. The prompt persona instructs models to emit a GBNF-style
      //    `[{tool, args}, ...]` array. Some cloud models (GPT-5 via
      //    aimlapi, GLM-5 via openrouter) follow the persona literally
      //    instead of using the OpenAI `tools` envelope — they put the
      //    JSON array in `content` and leave `tool_calls` empty. Try the
      //    grammar parser first; on success we keep the model's real
      //    intent (multi-call batches, tool args, reasoning preludes)
      //    instead of dumping the JSON literal into `reply.text`.
      // 2. Fallback: wrap the text as a length-1 `reply` batch so the
      //    one-inference-per-step contract holds. This is the companion
      //    of `tool_choice: "auto"` — Qwen-thinking, GLM-5 prelude-only,
      //    any model that thought it could just talk.
      //
      // Empty content is *not* synthesised — that case is intentionally
      // routed through `ModelError` by the outer caller because replaying
      // the same prompt would reproduce the same empty wall.
      const replyText = completion.content;
      if (typeof replyText === "string" && replyText.trim().length > 0) {
        try {
          const grammarBatch = parseToolCalls(
            normalizeContent(completion, profile, assumeOpenReasoning),
            getReasoningTagOptions(profile),
          );
          if (grammarBatch.calls.length > 0) {
            // The model copied the escaped function names from the OpenAI
            // `tools` schema (e.g. `skill__view`) into a GBNF-style content
            // array. Un-escape each name back to the dotted registry id so
            // `registry.has(...)` resolves — `nameUnescape` is a no-op for
            // names that are already dotted, so this is idempotent.
            const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
            const calls = grammarBatch.calls.map((call) => ({
              ...call,
              tool: adapter.nameUnescape(call.tool),
            }));
            return { ok: true, batch: { ...grammarBatch, calls } };
          }
        } catch {
          // Not a GBNF-shaped completion — fall through to the reply wrap.
        }
        const reasoning = resolveReasoning(
          completion,
          profile,
          assumeOpenReasoning,
        );
        return {
          ok: true,
          batch: {
            kind: "batch",
            calls: [
              {
                tool: "reply",
                args: { text: replyText },
                ...(reasoning.length > 0 ? { reasoning } : {}),
              },
            ],
            ...(reasoning.length > 0 ? { reasoning } : {}),
          },
        };
      }
      // Reasoning-only completion: no tool_calls, empty content, but the
      // think channel carries text. Models occasionally emit the
      // GBNF-style call array inside the think block — recover those
      // calls (they are the model's real intent). Anything else is NOT
      // salvaged: `reasoning_content` is internal scratch space by
      // OpenAI-compatible convention, and wrapping it as a `reply` leaks
      // raw chain-of-thought verbatim as deliberate agent speech (issue
      // #285). Returning `ok: false` routes the completion through the
      // same one-shot repair as every other unparseable body; a repair
      // that fails too ends the step as a parse error, not a CoT leak.
      const reasoningText =
        typeof completion.reasoningContent === "string"
          ? completion.reasoningContent.trim()
          : "";
      if (reasoningText.length > 0) {
        try {
          const grammarBatch = parseToolCalls(
            reasoningText,
            getReasoningTagOptions(profile),
          );
          if (grammarBatch.calls.length > 0) {
            const adapter = deps.toolCallAdapter ?? openAiToolCallAdapter;
            const calls = grammarBatch.calls.map((call) => ({
              ...call,
              tool: adapter.nameUnescape(call.tool),
            }));
            return { ok: true, batch: { ...grammarBatch, calls } };
          }
        } catch {
          // Not GBNF-shaped — fall through to the parse failure below.
        }
        return {
          ok: false,
          error: new Error(
            "reasoning-only completion: no tool_calls, empty content, and the reasoning body is not a tool-call array",
          ),
        };
      }
      return {
        ok: false,
        error: new Error(
          "native completion carried neither tool_calls nor content",
        ),
      };
    }
    const batch = parseToolCalls(
      normalizeContent(completion, profile, assumeOpenReasoning),
      getReasoningTagOptions(profile),
    );
    return { ok: true, batch };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}


/**
 * Wrap a completion's non-reasoning prose as a length-1 `reply` batch.
 * Returns `null` when the completion carries nothing but reasoning (a
 * model that degenerated inside its think block has no answer to
 * deliver, so the caller keeps its `GrammarError`).
 */
export function replyFallbackBatch(
  completion: CompletionResult,
  profile: ModelProfile,
  assumeOpenReasoning: boolean,
): ToolCallBatch | null {
  const extracted = extractReasoning(
    normalizeContent(completion, profile, assumeOpenReasoning),
    getReasoningTagOptions(profile),
  );
  const text = extracted.body.trim();
  if (text.length === 0) return null;
  // Only prose degrades. A body that opens a JSON value means the model
  // did try to emit a call and botched it (or the batch failed
  // validation) — echoing that literal back at the user would be worse
  // than the `GrammarError`.
  if (text.startsWith("{") || text.startsWith("[")) return null;
  const reasoning = resolveReasoning(completion, profile, assumeOpenReasoning);
  return {
    kind: "batch",
    calls: [
      {
        tool: "reply",
        args: { text },
        ...(reasoning.length > 0 ? { reasoning } : {}),
      },
    ],
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
}


/**
 * The reply cap a completion actually ran under, for the failure
 * detector. A provider that reports what went on the wire is believed,
 * `null` included: no cap was sent, and a cut was the provider's own
 * limit (request cloud-00312 carried no `max_tokens`, stopped at 33,678
 * tokens, and was reported as having "spent the reply cap of 8192"). A
 * provider that does not report keeps the old assumption — the cap the
 * step asked for, which is what llama-server's `n_predict` resolves to.
 */
export function replyCapSent(
  completion: CompletionResult,
  assumed: number,
): number | null {
  return completion.sentMaxTokens === undefined
    ? assumed
    : completion.sentMaxTokens;
}


/**
 * How much of the model's own text a log line carries. The log is a file
 * the operator may attach to a support report (the desktop app's "Save
 * report for support" takes its tail), and a completion can quote
 * anything the model read — a file's contents, a key that was in one —
 * so a line gives the text's length and its start, never the whole.
 */
export const LOG_TEXT_PREVIEW_CHARS = 300;


/** The first `max` characters of `text`, marked with `…` when cut. */
export function logTextPreview(text: string, max = LOG_TEXT_PREVIEW_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}


/**
 * Trim a raw completion body to the short preview attached to every
 * `GrammarError` so postmortems can tell grammar misconfiguration apart
 * from truncation or an empty response without digging through streaming
 * logs.
 */
export function rawPreview(content: string): string {
  const slice = content.slice(0, 240).replace(/\n/g, "\\n");
  return content.length > 240 ? `${slice}…` : slice;
}


/**
 * Hard cap on `n_predict` for the repair completion. See the comment at
 * the call-site (search `REPAIR_MAX_TOKENS` in this file) for the
 * rationale. Exported so tests can lower it for fast simulation.
 *
 * Bumped from 512 → 1024 after a multi-file rename trace showed
 * legitimate single-call `os.fs.edit` repairs (deep temp path + realistic
 * old/new strings) hitting the 512 ceiling and surfacing as
 * `GrammarError: tool-call body is empty`. 1024 still keeps the
 * anti-runaway guard well under `completionMaxTokens` (8192).
 *
 * Applies to grammar links only — see `repairReplyCap` for why the chat
 * transport runs the repair under the step's cap instead.
 */
export const REPAIR_MAX_TOKENS = 1024;


export function buildToolCallRepairPrompt(
  promptText: string,
  error: Error,
  profile?: ModelProfile,
  toolTransport?: ToolCallTransport,
  promptCarriedPrefill = true,
  thinkingOff = false,
): string {
  // Strip the trailing reasoning open-tag prefill (e.g. `<think>` for
  // qwen-think, `<|channel>thought\n` for gemma4-think) before
  // appending repair instructions. Without this strip, the repair
  // notice ends up wedged INSIDE the model's open think-block — the
  // model then treats the system instructions as its own prior thought
  // and enters a "wait, let me reconsider" loop that burns the entire
  // `n_predict` budget. Below we re-append the OPEN reasoning prefill
  // at the very end so the model continues in its normal think → emit
  // pattern (bounded by `REPAIR_MAX_TOKENS`).
  //
  // Earlier iterations of this function appended a CLOSED think-block
  // (`<think>\n</think>`) here, attempting a `/no_think` shortcut.
  // Production traces on both qwen-3.5-9b and qwen-3.6-35b-a3b showed
  // the model ignored the close marker and produced markdown-fenced
  // JSON with interleaved prose ("Wait, I need to..."), tripping
  // `GrammarError: tool-call body is empty`. Letting the model think
  // normally in repair — bounded by `REPAIR_MAX_TOKENS` so it cannot
  // run away — restores grammar-clean output.
  //
  // When the prompt never carried the prefill (native-tools chat
  // transport, issue #283) there is nothing to strip — and nothing to
  // re-append either: adding `<think>` here would ship the literal tag
  // to the cloud endpoint the main prompt deliberately keeps it out of.
  //
  // Under `thinking: off` (F49) the prefill IS the closed, empty think
  // block, and it is what comes back at the end: the repair runs under
  // the same plain-root grammar as the failed attempt, which admits no
  // reasoning, so re-opening a think block here would hand the model a
  // block it cannot close.
  const baseText = promptCarriedPrefill
    ? stripTrailingReasoningPrefill(promptText, profile, thinkingOff)
    : promptText;
  const lines = [
    baseText.trimEnd(),
    "",
    "### tool-call-repair",
    "The previous completion was rejected before any tool ran.",
    `reason: ${error.message}`,
  ];
  if (error instanceof BatchValidationError) {
    const perCall = error.perCall
      .map((reason, index) => (reason ? `- call[${index}]: ${reason}` : null))
      .filter((line): line is string => line !== null);
    if (perCall.length > 0) {
      lines.push("per-call errors:", ...perCall);
    }
  }
  // The corrective mandate must match the request's transport. This
  // repair replays with the SAME params as the failed attempt — under
  // `native_tools` that request carries the OpenAI `tools` payload and a
  // stable prefix that forbids text-JSON emission, so ordering a
  // "corrected JSON array" here would re-create the exact dual mandate
  // issue #285 removed, on the one retry a failing model gets before
  // GrammarError ends the step.
  if (toolTransport === "native_tools") {
    lines.push(
      "Call the tools again now, through the native function-calling interface (the `tools` payload on this API request) — do NOT write tool-call JSON as text, and do not leave the answer in the reasoning channel.",
      "Make it a single tool call for `reply`, `finish`, approval-gated tools, or any call that depends on a previous result.",
      "Do not repeat the invalid shape.",
      "",
      "### respond",
      "Respond now.",
    );
  } else {
    lines.push(
      "Emit a corrected JSON array only. No prose, no commentary after the array.",
      "Use a length-1 array for `reply`, `finish`, approval-gated tools, or any call that depends on a previous result.",
      "Do not repeat the invalid batch shape.",
      "",
      "### respond",
      "Respond now.",
    );
  }
  const openReasoning = promptCarriedPrefill
    ? renderOpenReasoningBlock(profile, thinkingOff)
    : "";
  if (openReasoning.length > 0) {
    lines.push(openReasoning);
  }
  return lines.join("\n");
}


export function stripTrailingReasoningPrefill(
  promptText: string,
  profile: ModelProfile | undefined,
  thinkingOff = false,
): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return promptText;
  if (profile.reasoningStyle === "none") return promptText;
  const disabledMarker = profile.promptThinkingDisabledMarker;
  if (thinkingOff && disabledMarker !== undefined) {
    const marker = disabledMarker.trimEnd();
    const trimmed = promptText.trimEnd();
    return trimmed.endsWith(marker)
      ? trimmed.slice(0, trimmed.length - marker.length)
      : promptText;
  }
  const framing = getReasoningTurnFraming(profile);
  if (framing) {
    // Gemma 4 turn-framing: strip the trailing `<turn|>\n<|turn>model` so the
    // repair instructions land back inside the open system turn.
    let trimmed = promptText.trimEnd();
    const assistantOpen = framing.assistantOpen.trimEnd();
    if (trimmed.endsWith(assistantOpen)) {
      trimmed = trimmed
        .slice(0, trimmed.length - assistantOpen.length)
        .trimEnd();
    }
    const turnClose = framing.turnClose.trimEnd();
    if (trimmed.endsWith(turnClose)) {
      trimmed = trimmed.slice(0, trimmed.length - turnClose.length).trimEnd();
    }
    return trimmed;
  }
  const openTag = profile.reasoningOpenTag.trimEnd();
  const trimmed = promptText.trimEnd();
  if (trimmed.endsWith(openTag)) {
    return trimmed.slice(0, trimmed.length - openTag.length);
  }
  return promptText;
}


/**
 * Re-append the reasoning open tag (e.g. `<think>`) at the end of the
 * repair prompt for thinking profiles, mirroring the shape of a normal
 * prompt. The model then continues in its standard think → `</think>`
 * → JSON flow, just bounded by `REPAIR_MAX_TOKENS`. For `none` profiles
 * this is a no-op.
 */
export function renderOpenReasoningBlock(
  profile: ModelProfile | undefined,
  thinkingOff = false,
): string {
  if (!profile || !profile.requiresPromptThinkPrefix) return "";
  if (profile.reasoningStyle === "none") return "";
  const disabledMarker = profile.promptThinkingDisabledMarker;
  if (thinkingOff && disabledMarker !== undefined) {
    // The template's own marker, verbatim — trailing newlines included,
    // as the main prompt ends.
    return disabledMarker;
  }
  const framing = getReasoningTurnFraming(profile);
  if (framing) {
    // Re-close the system turn and re-open the model turn so the model emits
    // its own `<|channel>thought` block (no prefilled open tag).
    return `${framing.turnClose.trimEnd()}\n${framing.assistantOpen.trimEnd()}`;
  }
  return profile.reasoningOpenTag.trimEnd();
}

export interface StepRepairArgs {
  ctx: StepContext;
  deps: StepDependencies;
  prompt: BuiltPrompt;
  slot: { cacheReused: boolean };
  llmParams: LlmStreamParams;
  grammarPrompt: (() => string) | undefined;
  promptCarriesPrefill: boolean;
  thinkingOff: boolean;
  replyCap: number;
  parsed: Extract<ToolCallBatchParseResult, { ok: false }>;
  assumesOpenReasoning: (completion: CompletionResult) => boolean;
  onRetryReasoning: (reasoning: string) => void;
}
export function prepareStepRepair(args: StepRepairArgs) {
  const { ctx, deps, prompt, llmParams, grammarPrompt, promptCarriesPrefill, thinkingOff, replyCap, parsed } = args;
  // One-shot repair: grammar outputs can be truncated or malformed for
  // transient reasons (stop-sequence race, model hiccup), and a batch
  // can fail validation when the model puts an approval-gated or
  // terminal verb inside an array. The repair call replays through the
  // unary LLM path with a short corrective notice appended — the
  // streaming path has already flushed partial deltas, so replaying
  // through it would double-emit.
  deps.onEvent?.({
    type: "parse_retry",
    stepIndex: ctx.stepIndex,
    attempt: 1,
    reason: parsed.error.message,
  });
  deps.logger?.warn("tool-call parse failed, repairing once", {
    sessionId: ctx.session.id,
    stepIndex: ctx.stepIndex,
    reason: parsed.error.message,
  });

  const retryStartedAt = Date.now();
  const repairError = parsed.error;
  return { retryStartedAt, buildRequest: (): LlmStreamParams => ({
    ...llmParams,
    prompt: buildToolCallRepairPrompt(
      prompt.text,
      repairError,
      deps.profile,
      deps.toolTransport,
      promptCarriesPrefill,
      thinkingOff,
    ),
    // The structured prompt must be repair-shaped too, or a native
    // link would replay the stale tail without the notice. The notice
    // lands at the end of the final user message; the chat form never
    // carried a prefill, so there is nothing to strip.
    ...(llmParams.messages
      ? {
          messages: {
            ...llmParams.messages,
            tail: buildToolCallRepairPrompt(
              llmParams.messages.tail,
              repairError,
              deps.profile,
              deps.toolTransport,
              false,
            ),
          },
        }
      : {}),
    // The grammar-link variant must be repair-shaped too — spreading
    // `llmParams` alone would hand a grammar fallback link the STALE
    // base prompt without the repair notice. It is repair-shaped for
    // the GRAMMAR transport: text-JSON corrective mandate (issue #285)
    // and the prefill strip/re-append (the grammar prompt carries it).
    ...(grammarPrompt
      ? {
          grammarPrompt: memoizeText(() =>
            buildToolCallRepairPrompt(
              grammarPrompt(),
              repairError,
              deps.profile,
              "grammar",
              true,
              thinkingOff,
            ),
          ),
        }
      : {}),
    // Bounded cap on the repair completion. Without it, reasoning
    // models (qwen-3.5-9b in particular) routinely fall into a
    // self-deliberation loop after a `BatchValidationError` and burn
    // the full `completionMaxTokens` (8192) generating dozens of
    // duplicated JSON candidates wrapped in "wait, let me reconsider"
    // prose — that's 3-5 minutes of wall time per repair on a 9B
    // model and the slot stays busy the entire time, cascading into
    // 0-step timeouts on subsequent eval cases.
    //
    // The cap was originally 512 but production traces of a
    // multi-file rename refactor showed legitimate single-call
    // `os.fs.edit` repairs (absolute path in a deep temp dir +
    // realistic `oldString`/`newString`) hitting exactly that
    // ceiling, truncating mid-JSON, and surfacing as
    // `GrammarError: tool-call body is empty`. 1024 keeps the
    // anti-loop guard (still well under `completionMaxTokens=8192`)
    // while leaving room for one full edit call in the worst case.
    //
    // Grammar links only. On the chat transport a reasoning model
    // thinks server-side, with no prefill to strip, and 1024 is a
    // guaranteed truncation — the repair would end every turn it was
    // meant to save. See `repairReplyCap`.
    maxTokens: repairReplyCap(deps.toolTransport, replyCap),
  }) };
}

export type PreparedStepRepair = ReturnType<typeof prepareStepRepair>;

export function finishStepRepair(
  args: StepRepairArgs,
  repair: PreparedStepRepair,
  completion: CompletionResult,
): ParseDeps {
  const { ctx, deps, prompt, slot, replyCap, assumesOpenReasoning, onRetryReasoning } = args;
  const { retryStartedAt } = repair;
  const retryDurationMs = Date.now() - retryStartedAt;
  const retryReasoning = resolveReasoning(
    completion,
    deps.profile,
    assumesOpenReasoning(completion),
  );
  deps.onCompletion?.(completion);
  deps.onEvent?.({ type: "llm_completed", completion });
  deps.onEvent?.({
    type: "llm_raw_completion",
    stepIndex: ctx.stepIndex,
    attempt: 2,
    completion,
    reasoningTokens: estimateReasoningTokens(retryReasoning),
  });
  deps.metrics?.recordLlmCall({
    sessionId: ctx.session.id,
    promptTokens: completion.timing?.promptTokens ?? prompt.tokens.total,
    completionTokens: completion.timing?.predictedTokens ?? 0,
    durationMs: retryDurationMs,
    cacheReused: slot.cacheReused,
  });

  if (retryReasoning.length > 0) {
    deps.onEvent?.({
      type: "reasoning",
      stepIndex: ctx.stepIndex,
      text: retryReasoning,
    });
    onRetryReasoning(retryReasoning);
  }

  // Same defensive check on the retry completion. If the model produced
  // a truncated or empty reply on the second attempt, it is a model
  // failure, not a grammar one — no point emitting `GrammarError` for
  // an empty body.
  const retryModelFailure = detectModelFailure(completion, {
    requestedMaxTokens: replyCapSent(
      completion,
      repairReplyCap(deps.toolTransport, replyCap),
    ),
    defaultReplyCap: repairReplyCap(deps.toolTransport, replyCap),
    stage: "repair",
    contextWindow: deps.contextWindow ?? null,
  });
  const retryParseDeps = parseDepsFor(completion, deps);
  if (
    retryModelFailure !== null &&
    !isNativeToolsEmptyCompletionHandledByParser(
      retryParseDeps,
      retryModelFailure.reason,
      completion,
    )
  ) {
    deps.logger?.warn("model-side completion defect on parse retry", {
      sessionId: ctx.session.id,
      stepIndex: ctx.stepIndex,
      reason: retryModelFailure.reason,
    });
    throw new ModelError(
      retryModelFailure.reason,
      retryModelFailure.message,
      // Same rule as the first-attempt throw: report the transport that
      // served this completion, not the configured one.
      //
      // `stage: "repair"` — reached only after the one-shot repair ran,
      // including the `native_tools` case where the first attempt was
      // `content`-empty but carried `reasoning_content` (so the
      // first-attempt throw was skipped) and the repair came back with
      // nothing in any channel. Same `reason=empty`, same
      // `transport=native_tools`, different story.
      {
        transport: retryParseDeps.toolTransport,
        stage: "repair",
        ...(retryModelFailure.truncation
          ? { truncation: retryModelFailure.truncation }
          : {}),
      },
    );
  }
  return retryParseDeps;
}
