/**
 * Ollama Cloud's serving layer drops or mangles literal thinking-tag
 * strings that appear inside message content (issue #283; upstream
 * ollama/ollama#17248 and #17617). A file read, a diff or a user message
 * that merely mentions `<think>` reaches the model altered.
 *
 * Provider-scoped workaround: for `ollama.com` only, the four tags are
 * rewritten to visible brackets before the request goes out. Visible on
 * purpose: an invisible separator (U+200B) would be copied by the model
 * into `os.fs.edit` / `os.fs.write` and plant hidden bytes in files.
 * Each replacement has the same length as its tag. Reasoning fields are
 * never touched. Every other host, local Ollama included, is sent as
 * before. Remove once the upstream bugs are fixed.
 */

const THINK_TAG = /<(\/?)(think|thinking)>/g;

/** Whether the base URL is Ollama's hosted API (the `ollama-cloud` preset). */
export function isOllamaCloudHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "ollama.com" || host.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

/** `<think>` to `[think]`, `</thinking>` to `[/thinking]`; other text unchanged. */
export function neutralizeThinkTags(text: string): string {
  return text.replace(THINK_TAG, "[$1$2]");
}

/**
 * One outgoing chat message with its tags neutralized: string `content`,
 * the `text` of content parts, and every `tool_calls[].function.arguments`.
 * `reasoning_content`, `reasoning` and any other field are kept as they
 * are. A message with nothing to change comes back as the same object.
 */
export function neutralizeThinkTagsInMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  let out = message;
  const content = message.content;
  if (typeof content === "string") {
    const safe = neutralizeThinkTags(content);
    if (safe !== content) out = { ...out, content: safe };
  } else if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part: unknown) => {
      if (!isRecord(part) || typeof part.text !== "string") return part;
      const safe = neutralizeThinkTags(part.text);
      if (safe === part.text) return part;
      changed = true;
      return { ...part, text: safe };
    });
    if (changed) out = { ...out, content: parts };
  }
  const calls = message.tool_calls;
  if (Array.isArray(calls)) {
    let changed = false;
    const safeCalls = calls.map((call: unknown) => {
      if (!isRecord(call) || !isRecord(call.function)) return call;
      const args = call.function.arguments;
      if (typeof args !== "string") return call;
      const safe = neutralizeThinkTags(args);
      if (safe === args) return call;
      changed = true;
      return { ...call, function: { ...call.function, arguments: safe } };
    });
    if (changed) out = { ...out, tool_calls: safeCalls };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
