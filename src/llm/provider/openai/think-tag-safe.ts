/**
 * Ollama Cloud's serving layer drops or mangles literal thinking-tag
 * strings that appear inside message content (issue #283; upstream
 * ollama/ollama#17248 and #17617). A file read, a diff or a user message
 * that merely mentions `<think>` reaches the model altered.
 *
 * Provider-scoped workaround: for Ollama cloud models, wherever they are
 * reached, the four tags are rewritten to visible brackets before the
 * request goes out. That is the `ollama.com` host, and a cloud model
 * (`deepseek-v4-flash:cloud`, `gpt-oss:120b-cloud`) run through a local
 * Ollama daemon, which proxies it to Ollama Cloud (ATO-2771; that is how
 * #17617 was reproduced). Visible on purpose: an invisible separator
 * (U+200B) would be copied by the model into `os.fs.edit` /
 * `os.fs.write` and plant hidden bytes in files. Each replacement has
 * the same length as its tag. Reasoning fields are never touched. Local
 * models on local Ollama, and every other host, are sent byte-identical.
 * Remove once the upstream bugs are fixed.
 */

import { isLocalServerUrl } from "./local-server-url.js";

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

/**
 * Whether a model id is one Ollama serves from its cloud: the `:cloud`
 * tag (`deepseek-v4-flash:cloud`) or a `-cloud` tag suffix
 * (`gpt-oss:120b-cloud`). Only meaningful on an Ollama endpoint.
 */
export function isOllamaCloudModel(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.trim().toLowerCase();
  return id.endsWith(":cloud") || id.endsWith("-cloud");
}

/**
 * Whether a provider entry is an Ollama daemon rather than the hosted
 * API: the `ollama` preset id, or a server on this machine or network on
 * Ollama's default port 11434. Same rule as `isOllamaEntry`
 * (`ollama/ollama-context-window.ts`) and `isExternalEngineEntry`.
 */
export function isOllamaDaemon(
  id: string | undefined,
  baseUrl: string | undefined,
): boolean {
  if (!baseUrl || isOllamaCloudHost(baseUrl)) return false;
  if (id === "ollama") return true;
  if (!isLocalServerUrl(baseUrl)) return false;
  try {
    return new URL(baseUrl).port === "11434";
  } catch {
    return false;
  }
}

/**
 * Whether outgoing tags must be neutralized for this provider and model:
 * the hosted API always, an Ollama daemon only for a cloud model.
 */
export function needsThinkTagSafe(entry: {
  id?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}): boolean {
  if (isOllamaCloudHost(entry.baseUrl)) return true;
  return (
    isOllamaDaemon(entry.id, entry.baseUrl) && isOllamaCloudModel(entry.model)
  );
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
