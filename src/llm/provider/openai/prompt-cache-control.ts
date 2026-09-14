/**
 * Anthropic prompt-cache breakpoints on an OpenAI-shaped `messages`
 * array.
 *
 * Anthropic caches nothing unless the request says where the cacheable
 * prefix ends: a `cache_control: {type: "ephemeral"}` on a content part.
 * OpenRouter forwards the marker for `anthropic/…` models, and an
 * Anthropic-compatible endpoint reads it directly. Without it every step
 * of a long turn pays the full input price for a prefix that has not
 * changed since the previous step.
 *
 * Two breakpoints, out of the four Anthropic allows:
 *  - the system message — the stable prefix, identical for the whole
 *    session and across sessions on the same tool set;
 *  - the last history message before the tail — the prefix grows by one
 *    step's worth of messages each step, and a breakpoint at its end
 *    lets the next request read everything up to here from the cache.
 *
 * A breakpoint inside the changing tail would cache nothing and pay the
 * cache-write premium, so the final message is never marked. Marks land
 * on text parts only: an assistant message that is nothing but
 * `tool_calls` has no part to carry one, so the walk skips back to the
 * nearest message with text.
 */

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Whether the model id names an Anthropic model, on any service:
 * `anthropic/claude-…` through a router, `claude-…` directly.
 */
export function isAnthropicModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith("anthropic/") || lower.includes("claude");
}

/** Whether the base URL is Anthropic's own API. */
export function isAnthropicHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.endsWith("api.anthropic.com");
  } catch {
    return false;
  }
}

/**
 * Whether Google models routed through OpenRouter should be steered to
 * the routes that honour prompt caching (Google AI Studio cached 83 % of
 * input in the benchmark; Vertex 1–4 %).
 */
export function isGoogleModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("google/");
}

/**
 * OpenRouter `provider` preferences that keep a Google model on its
 * cache-capable routes while still allowing a fallback when both are
 * down. Applied only when the operator configured no preferences of
 * their own and `llm.openrouter.preferCacheRoutes` is not off.
 */
export const GOOGLE_CACHE_ROUTE_PREFERENCES: Readonly<Record<string, unknown>> =
  Object.freeze({
    order: ["Google AI Studio", "Google"],
    allow_fallbacks: true,
  });

type Message = Record<string, unknown>;

/**
 * Return a copy of `messages` with the breakpoints applied. The input
 * array and its messages are not mutated. Messages with a non-string
 * `content` (already parts, or `null`) are left as they are except that a
 * parts array gets the marker on its last text part.
 */
export function applyAnthropicCacheControl(
  messages: ReadonlyArray<Message>,
): Message[] {
  const out = messages.map((message) => ({ ...message }));
  if (out.length === 0) return out;
  const first = out[0]!;
  if (first.role === "system") {
    out[0] = withCacheControl(first) ?? first;
  }
  // The last history message: everything before the final (tail)
  // message, and after the system message. Walk back over messages that
  // cannot carry a marker.
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const marked = withCacheControl(out[i]!);
    if (marked !== null) {
      out[i] = marked;
      break;
    }
  }
  return out;
}

function withCacheControl(message: Message): Message | null {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) return null;
    return {
      ...message,
      content: [{ type: "text", text: content, cache_control: EPHEMERAL }],
    };
  }
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const part = content[i] as Record<string, unknown> | null;
      if (part && part.type === "text" && typeof part.text === "string") {
        const parts = [...content];
        parts[i] = { ...part, cache_control: EPHEMERAL };
        return { ...message, content: parts };
      }
    }
  }
  return null;
}
