/**
 * The sentence appended to a Structured Outputs prompt that never says
 * "json". Content-neutral on purpose: the schema itself travels in
 * `response_format`, this only satisfies the word check.
 */
export const JSON_RESPONSE_INSTRUCTION =
  "Respond with a JSON object that matches the requested schema.";

/**
 * `prompt`, guaranteed to contain the word "json" in some casing.
 *
 * Alibaba's Qwen endpoints — DashScope directly, and `qwen/*` routed
 * through OpenRouter — refuse any request that carries `response_format`
 * unless the messages contain that word, with a 400 before the model
 * runs: "'messages' must contain the word 'json' in some form". OpenAI
 * states the same requirement for its JSON mode. The memory sub-call
 * prompts (rewriter, vote, link-generator) were written for the
 * llama-server GBNF path and describe line grammars or a tag envelope,
 * so on those models every one of them failed.
 *
 * Only `buildOpenAiChatBody` calls this, and only for a request it
 * attaches `response_format` to. Nothing else moves:
 *   - the llama-server path never builds an OpenAI body, so the prompt
 *     the reflection slot caches stays byte-identical;
 *   - the main agent turn sends no `response_format`, and a request
 *     with `tools` never gets one, so neither prompt is touched;
 *   - a prompt that already says json passes through unchanged.
 */
export function ensureJsonMention(prompt: string): string {
  if (/json/i.test(prompt)) return prompt;
  const separator = prompt.endsWith("\n") ? "\n" : "\n\n";
  return `${prompt}${separator}${JSON_RESPONSE_INSTRUCTION}`;
}
