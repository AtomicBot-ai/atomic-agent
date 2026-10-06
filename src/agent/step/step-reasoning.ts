import type { ModelProfile } from "../../llm/model-profile.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { extractReasoning } from "../../llm/grammar/tool-call-grammar.js";
import { reasoningOpenEmittedByModel } from "../../llm/model-profile.js";


/**
 * Whether the prompt built for this runtime carries the trailing
 * reasoning-open prefill (`<think>` for qwen-think) / Gemma turn-framing
 * tokens.
 *
 * The prefill is a llama-server *text-completion* artifact: the local
 * template expects the open tag pre-typed at the generation point. On
 * the native-tools chat transport the prompt ships as a chat message to
 * an OpenAI-compatible endpoint, where the literal tag is at best noise
 * the model echoes back and at worst corrupted server-side (Ollama
 * Cloud mangles literal `<think>`/`</think>` strings —
 * ollama/ollama#17248, issue #283) — so `buildPrompt` suppresses it
 * there. This predicate keys the PROMPT-side consumers (the alignment
 * invariant check, the repair prompt's strip/re-append). Parse-side
 * consumers key off `completionAssumesOpenReasoning` with the transport
 * that actually served the completion instead — the two differ on a
 * cross-transport fallover.
 */
export function promptCarriesReasoningPrefill(
  profile: ModelProfile,
  toolTransport: ToolCallTransport,
): boolean {
  return toolTransport !== "native_tools" && profile.requiresPromptThinkPrefix;
}


/**
 * Whether a completion should be parsed as continuing an already-open
 * reasoning block (re-prepending the open tag before extraction /
 * pre-opening the stream parser's think state).
 *
 * Keyed purely off the transport that served (or is serving) the
 * completion:
 *  - **Grammar-served output always starts mid-think** — the GBNF
 *    prelude root emits `body "</think>"` without the open tag — even
 *    when the prompt did not prefill (a native-tools primary that fell
 *    over to a grammar local link is handed the prefill-carrying
 *    `grammarPrompt` variant anyway, see `LlmStreamParams.grammarPrompt`).
 *  - **A chat (native-tools) completion never continues our
 *    text-completion prefill**: the reply starts fresh server-side, so
 *    prepending the open tag would swallow a clean reply whole as
 *    reasoning. That holds even in the unsupported grammar-primary →
 *    native-link ordering, where the outbound prompt still (incorrectly)
 *    carries the literal prefill inside the chat message.
 *  - **`thinking: off` on the built prompt (F49)** ends the prompt with
 *    the template's closed, empty think block and sends the plain-root
 *    grammar, so a grammar-served completion starts on the tool call:
 *    nothing to re-open.
 */
export function completionAssumesOpenReasoning(
  profile: ModelProfile,
  parseTransport: ToolCallTransport,
  thinkingOff: boolean,
): boolean {
  if (!profile.requiresPromptThinkPrefix) return false;
  if (thinkingOff) return false;
  return parseTransport !== "native_tools";
}


/**
 * Memoize a lazily built prompt variant so the extra `buildPrompt` /
 * repair-prompt render runs at most once per step however many fallback
 * attempts consume it.
 */
export function memoizeText(build: () => string): () => string {
  let cached: string | null = null;
  return () => (cached ??= build());
}


/**
 * Resolve the reasoning text for a completion, preferring the dedicated
 * `reasoning_content` channel when present and falling back to inline
 * `<think>...</think>` extraction for classic llama-server builds.
 */
export function resolveReasoning(
  completion: CompletionResult,
  profile: ModelProfile,
  assumeOpenReasoning: boolean,
): string {
  const fromChannel =
    typeof completion.reasoningContent === "string"
      ? completion.reasoningContent
      : "";
  if (fromChannel.length > 0) return fromChannel;
  const normalizedContent = normalizeContent(
    completion,
    profile,
    assumeOpenReasoning,
  );
  const extracted = extractReasoning(
    normalizedContent,
    getReasoningTagOptions(profile),
  );
  return extracted.reasoning;
}


export function normalizeContent(
  completion: CompletionResult,
  profile: ModelProfile,
  assumeOpenReasoning: boolean,
): string {
  return assumeOpenReasoning
    ? `${getReasoningOpenTagPrefix(profile)}${completion.content}`
    : completion.content;
}


/**
 * A completion's text as the user would see it: `content` with any
 * inline reasoning block removed. The dedicated `reasoning_content`
 * channel is never part of it.
 */
export function completionFreeText(
  completion: CompletionResult,
  profile: ModelProfile,
  assumeOpenReasoning: boolean,
): string {
  if (typeof completion.content !== "string" || completion.content === "") {
    return "";
  }
  return extractReasoning(
    normalizeContent(completion, profile, assumeOpenReasoning),
    getReasoningTagOptions(profile),
  ).body;
}


export function getReasoningOpenTagPrefix(profile: ModelProfile): string {
  if (profile.reasoningStyle === "none") return "";
  // When the model emits its own open tag (Gemma 4 turn-framing) the tag is
  // already present in `completion.content` — prepending it would duplicate
  // it, so `normalizeContent` must add nothing.
  if (reasoningOpenEmittedByModel(profile)) return "";
  return profile.reasoningOpenTag;
}


export function getReasoningTagOptions(profile: ModelProfile): {
  openTag?: string;
  closeTag?: string;
} {
  if (profile.reasoningStyle === "none") return {};
  return {
    openTag: profile.reasoningOpenTag,
    closeTag: profile.reasoningCloseTag,
  };
}
