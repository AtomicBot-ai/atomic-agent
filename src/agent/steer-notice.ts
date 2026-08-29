/**
 * Renders mid-turn user messages into the `### notice` block of the next
 * step's prompt.
 *
 * The block is deliberately imperative and deliberately redundant: the
 * same text also lands in `### conversation` as a real `user` turn (the
 * transcript must not lie about what the operator said), but
 * `### conversation` is a long scroll and the models this runtime
 * targets are small. `### notice` sits immediately before
 * `### respond`, which is the one place a 30B local model reliably
 * reads, so the message is repeated there with an instruction attached.
 */

/**
 * Per-message inline cap. A pasted stack trace should not evict the rest
 * of the tail from the token budget — past this the model is pointed at
 * the full copy in `### conversation`.
 */
const MAX_INLINE_CHARS = 600;

/**
 * Aggregate cap across the whole block. Sixteen backlogged messages at
 * the per-message cap would put ~10KB immediately before `### respond`
 * and squeeze the conversation out of the token budget; past this the
 * remaining messages are counted, not inlined — they are all real user
 * turns in `### conversation` either way.
 */
const MAX_BLOCK_CHARS = 2400;

/**
 * Fold `messages` into an existing one-shot notice (the loop detector
 * writes to the same slot). The loop-detector text comes first: it
 * describes what the model just did wrong, which is context for how to
 * act on the new instruction.
 */
export function composeSteerNotice(
  existing: string | undefined,
  messages: readonly string[],
): string | undefined {
  if (messages.length === 0) return existing;
  const block = formatSteerNotice(messages);
  if (existing === undefined || existing.length === 0) return block;
  return `${existing}\n\n${block}`;
}

/** The steering block on its own, without the loop-detector prefix. */
export function formatSteerNotice(messages: readonly string[]): string {
  if (messages.length === 0) return "";
  const header =
    messages.length === 1
      ? "The user sent a new message while you were working. Take it into account before your next action — it may change or cancel what you were doing:"
      : `The user sent ${messages.length} new messages while you were working. Take them into account before your next action — they may change or cancel what you were doing:`;
  const lines: string[] = [];
  let used = 0;
  let elided = 0;
  for (const m of messages) {
    const line = `- ${clip(m)}`;
    if (used + line.length > MAX_BLOCK_CHARS && lines.length > 0) {
      elided += 1;
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  if (elided > 0) {
    lines.push(
      `- …and ${elided} more (all shown in full as the latest user turns in ### conversation)`,
    );
  }
  return `${header}\n${lines.join("\n")}`;
}

function clip(text: string): string {
  const flat = text.trim();
  if (flat.length <= MAX_INLINE_CHARS) return flat;
  // Code-point slice, not a UTF-16 slice: a cut through a surrogate
  // pair would put mojibake into the prompt.
  const points = [...flat].slice(0, MAX_INLINE_CHARS).join("");
  return `${points}… (full text is the last user turn in ### conversation)`;
}
