import type { CompletionResult, OpenAiToolCall, StreamChunk } from "../completion-types.js";
import {
  createStreamUnmasker,
  isPrivacyShieldEnabled,
  privacyNameDetector,
  privacyVaultFor,
  refineFoundValues,
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
 * Roles whose text the local name pass reads: what the person wrote and
 * what tools brought in (ATO-2527). Not the system prompt (ours).
 */
const NAME_ROLES: ReadonlySet<string> = new Set(["user", "tool", "function"]);

/**
 * Vaults whose first names pass has run in this process; from then on
 * assistant replies are skipped. A reply written after that pass came
 * from the cloud through this vault, with the vault's values put back,
 * so any name in it is known already or one the cloud wrote itself.
 * Replies the vault never saw are read once, on its first pass: an
 * imported session (Hermes, Codex, Claude Code, the Claude app, a
 * handoff), the chat before an agent restart (vaults live in memory),
 * and replies a local model wrote before the first cloud request.
 */
const repliesRead = new WeakSet<PrivacyVault>();

/** Text parts joined as one string; a space only where two words would touch. */
function joinParts(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (out.length > 0 && !/\s$/u.test(out) && !/^\s/u.test(part)) out += " ";
    out += part;
  }
  return out;
}

/**
 * The texts of outgoing `messages` the local name pass reads: user and
 * tool messages, and assistant replies when `replies` is set (the
 * vault's first pass), string content or the `text` of content parts. The
 * parts of one message are read as one text, so a name split across two
 * parts (`"Call Иван"`, `" Петров"`) is seen whole; the vault then masks
 * each part because a name's words are learned too (`refineFoundValues`).
 */
export function messageTextsForNames(
  messages: unknown,
  options: { replies?: boolean } = {},
): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const { role, content } = message as Record<string, unknown>;
    if (typeof role !== "string") continue;
    if (!NAME_ROLES.has(role) && !(options.replies === true && role === "assistant")) continue;
    if (typeof content === "string") {
      if (content.length > 0) out.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const part of content) {
      const text = (part as Record<string, unknown> | null)?.text;
      if (typeof text === "string" && text.length > 0) parts.push(text);
    }
    if (parts.length > 0) out.push(joinParts(parts));
  }
  return out;
}

/**
 * Names, addresses and organisations (ATO-2394): before the body is
 * masked, the local name pass reads the request's messages and the vault
 * learns what it found, so the sync `maskOpenAiBody` that follows masks
 * those too. `readMessages` builds the unmasked `messages` and runs only
 * when a local model is there to read them. Any failure here leaves the
 * vault as it was: the request still goes out masked by regex.
 */
export async function learnNamesForRequest(
  vault: PrivacyVault,
  readMessages: () => unknown,
  signal?: AbortSignal,
): Promise<void> {
  const detector = privacyNameDetector();
  if (detector === null) return;
  const replies = !repliesRead.has(vault);
  // The detector reads the texts only when a local model is there and
  // the switch is on; only a pass that read them counts as the first.
  const pass = { read: false };
  try {
    const found = await detector.detect(() => {
      pass.read = true;
      return messageTextsForNames(readMessages(), { replies });
    }, signal);
    const values = refineFoundValues(found);
    if (values.length > 0) vault.learn(values);
    if (pass.read && signal?.aborted !== true) repliesRead.add(vault);
  } catch {
    // The detector does not throw by contract; if it ever does, regex only.
  }
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
