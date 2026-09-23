import type { StructuredLogger } from "../../../tracing/structured-logger.js";
import type { ChatPromptParts } from "../completion-types.js";
import { LlamaServerError } from "../../llama-server-client.js";

/**
 * Renders a local prompt through the model's own chat template, keeping
 * the stable prefix stable.
 *
 * The prompt reaches the provider as two parts: the stable prefix
 * (system, rules, tools — identical from step to step) and the tail
 * (conversation, notices, `### respond`). Sending them to
 * `/apply-template` as a system and a user message gives the model the
 * turn markers its template expects. Doing that on every step would
 * cost a round trip each time and, worse, would let the template touch
 * the prefix bytes per request. So the prefix is rendered once per
 * stable-prefix hash with a sentinel in the user slot; the template's
 * output splits at the sentinel into a head (everything up to the user
 * content) and a foot (the user turn's close and the assistant opener),
 * and each step is `head + tail + foot`. The head is byte-stable, so
 * llama-server's prefix cache reuses it exactly as it reused the raw
 * prefix.
 *
 * Failure is never fatal: a server without the endpoint (older builds
 * answer 404), a template that loses the sentinel, or a network error
 * all fall back to the raw text prompt, with one log line.
 */
export type ApplyTemplate = (
  messages: ReadonlyArray<{ role: string; content: string }>,
  chatTemplateKwargs: Record<string, unknown> | undefined,
) => Promise<string>;

export interface ServerTemplateRendererOptions {
  applyTemplate: ApplyTemplate;
  logger?: StructuredLogger;
}

/** Rendered prefixes kept per process; a prefix hash changes rarely. */
const CACHE_MAX_ENTRIES = 8;

/** Stands in for the tail while the prefix is rendered; never appears in a real prompt. */
export const TAIL_SENTINEL = "ATAG_TAIL_SENTINEL_7f3a";

interface RenderedPrefix {
  head: string;
  foot: string;
}

export class ServerTemplateRenderer {
  private readonly applyTemplate: ApplyTemplate;
  private readonly logger: StructuredLogger | undefined;
  private readonly cache = new Map<string, RenderedPrefix>();
  /** Set once the server has shown it has no `/apply-template`. */
  private unsupported = false;

  constructor(options: ServerTemplateRendererOptions) {
    this.applyTemplate = options.applyTemplate;
    this.logger = options.logger;
  }

  /**
   * The prompt to send to `/completion`, or `null` when the template
   * path is unavailable and the caller should send its raw text.
   * `modelKey` names the model whose template is in force, so a hot
   * swap to a different GGUF never reuses another template's framing.
   */
  async render(
    parts: ChatPromptParts,
    modelKey: string,
  ): Promise<string | null> {
    if (this.unsupported) return null;
    const key = `${parts.prefixHash}|${modelKey}|${String(parts.enableThinking)}`;
    let rendered = this.cache.get(key);
    if (rendered === undefined) {
      rendered = (await this.renderPrefix(parts)) ?? undefined;
      if (rendered === undefined) return null;
      this.remember(key, rendered);
    }
    return `${rendered.head}${parts.user}${rendered.foot}`;
  }

  private async renderPrefix(
    parts: ChatPromptParts,
  ): Promise<RenderedPrefix | null> {
    const kwargs =
      parts.enableThinking === undefined
        ? undefined
        : { enable_thinking: parts.enableThinking };
    let text: string;
    try {
      text = await this.applyTemplate(
        [
          { role: "system", content: parts.system },
          { role: "user", content: TAIL_SENTINEL },
        ],
        kwargs,
      );
    } catch (err) {
      if (
        err instanceof LlamaServerError &&
        (err.status === 404 || err.status === 405 || err.status === 501)
      ) {
        this.unsupported = true;
        this.logger?.warn(
          "llama-server has no /apply-template; local prompts stay in atag's own framing",
          { status: err.status },
        );
        return null;
      }
      this.logger?.warn(
        "chat template render failed; sending the raw prompt for this step",
        { error: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
    const at = text.indexOf(TAIL_SENTINEL);
    if (at === -1 || text.lastIndexOf(TAIL_SENTINEL) !== at) {
      this.logger?.warn(
        "chat template did not carry the user content through; sending the raw prompt",
        { occurrences: at === -1 ? 0 : 2 },
      );
      return null;
    }
    return {
      head: text.slice(0, at),
      foot: text.slice(at + TAIL_SENTINEL.length),
    };
  }

  private remember(key: string, rendered: RenderedPrefix): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, rendered);
  }
}
