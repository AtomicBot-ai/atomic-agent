import type { CompletionResult, OpenAiToolCall, StreamChunk } from "../completion-types.js";
import {
  createStreamUnmasker,
  isPrivacyShieldEnabled,
  privacyVaultFor,
  type PrivacyVault,
} from "../../../privacy/index.js";

/**
 * Privacy Shield on the OpenAI-compatible wire (ATO-1081). Every cloud
 * provider of the agent (OpenAI, OpenRouter, Gemini, AIMLAPI, Groq,
 * DeepSeek, Moonshot, any custom endpoint) is an `OpenAiProvider`, so
 * this is the one place a cloud request leaves and its reply comes back.
 *
 *  - Out: `maskOpenAiBody` swaps personal data and keys in the body's
 *    `messages` for the session's placeholders. Only `messages`: the
 *    tool schemas and sampling fields are ours, not the person's.
 *  - Back: `unmaskCompletion` and `createChunkUnmasker` put the values
 *    back in the reply text, the reasoning and the tool-call arguments,
 *    before the runtime shows, stores or runs any of it. Session history
 *    therefore keeps the real text, and the next request masks it again
 *    to the same placeholders.
 *
 * Never for a server on this machine or the local network (llama.cpp,
 * LM Studio, Ollama, vLLM): the caller passes `local`, and the managed
 * llama-server route is a different provider class altogether.
 */

/** The vault for this request, or `null` when the shield does not apply. */
export function shieldVaultFor(
  sessionId: string | undefined,
  local: boolean,
): PrivacyVault | null {
  if (local || !isPrivacyShieldEnabled()) return null;
  return privacyVaultFor(sessionId);
}

/**
 * Mask `body.messages` in place (the body is freshly built per send) and
 * count what this request masked (`vault.stats().lastRequest`).
 */
export function maskOpenAiBody(body: Record<string, unknown>, vault: PrivacyVault): void {
  vault.beginRequest();
  try {
    if (body.messages !== undefined) body.messages = vault.maskDeep(body.messages);
  } finally {
    vault.endRequest();
  }
}

function unmaskToolCalls(
  calls: ReadonlyArray<OpenAiToolCall> | undefined,
  vault: PrivacyVault,
): ReadonlyArray<OpenAiToolCall> | undefined {
  if (!calls) return calls;
  let changed = false;
  const out = calls.map((call) => {
    // Arguments are JSON text: a restored value goes in escaped, so a
    // quote in a real value cannot break the call.
    const args = vault.unmask(call.function.arguments, { json: true });
    const name = vault.unmask(call.function.name);
    if (args === call.function.arguments && name === call.function.name) return call;
    changed = true;
    return { ...call, function: { ...call.function, name, arguments: args } };
  });
  return changed ? out : calls;
}

/** `result` with the session's placeholders put back everywhere the model writes. */
export function unmaskCompletion<T extends CompletionResult>(result: T, vault: PrivacyVault): T {
  if (vault.isEmpty) return result;
  const content = vault.unmask(result.content);
  const reasoningContent = vault.unmask(result.reasoningContent);
  const toolCalls = unmaskToolCalls(result.toolCalls, vault);
  if (
    content === result.content &&
    reasoningContent === result.reasoningContent &&
    toolCalls === result.toolCalls
  ) {
    return result;
  }
  return {
    ...result,
    content,
    reasoningContent,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

export interface ChunkUnmasker {
  /** The chunk with its text unmasked; a placeholder cut at its end is held back. */
  push(chunk: StreamChunk): StreamChunk;
  /** Whatever was held back at the end of the stream, or `null` for nothing. */
  flush(): StreamChunk | null;
}

/**
 * Unmasks streamed chunks. The reply and the reasoning are separate
 * streams, each with its own hold-back for a placeholder split between
 * two chunks (`[EMA` + `IL_1]`). One per stream attempt: a reopened
 * stream starts from scratch.
 */
export function createChunkUnmasker(vault: PrivacyVault): ChunkUnmasker {
  const text = createStreamUnmasker(vault);
  const reasoning = createStreamUnmasker(vault);
  return {
    push(chunk) {
      const delta = text.push(chunk.delta);
      const reasoningDelta = reasoning.push(chunk.reasoningDelta);
      if (delta === chunk.delta && reasoningDelta === chunk.reasoningDelta) return chunk;
      return { ...chunk, delta, reasoningDelta };
    },
    flush() {
      const delta = text.flush();
      const reasoningDelta = reasoning.flush();
      if (delta.length === 0 && reasoningDelta.length === 0) return null;
      return { delta, reasoningDelta, done: false };
    },
  };
}
