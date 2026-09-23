import type { SessionState } from "../session/session-state.js";
import { formatToolForLoadedTail } from "./stable-prefix.js";
import { estimateTokens, truncateToTokens } from "./token-budget.js";

export interface RenderedLoadedTools {
  /** Section body only (no `### loaded-tools` header). */
  body: string | null;
  /** True if `truncateToTokens` trimmed the body. */
  truncated: boolean;
  tokens: number;
}

export interface RenderLoadedToolsOptions {
  /**
   * Names NOT to render: tools the stable prefix already describes in
   * full for the current tool role. A loaded copy of one of those would
   * only duplicate the prefix in the tail.
   */
  skip?: ReadonlySet<string>;
}

/**
 * Renders `### loaded-tools` body from `session.loadedTools`, capped by
 * `maxTokens` (estimated).
 */
export function renderLoadedToolsSection(
  session: SessionState,
  maxTokens: number,
  options: RenderLoadedToolsOptions = {},
): RenderedLoadedTools {
  const loaded = (session.loadedTools ?? []).filter(
    (t) => !options.skip?.has(t.name),
  );
  if (loaded.length === 0) {
    return { body: null, truncated: false, tokens: 0 };
  }
  if (maxTokens <= 0) {
    return { body: null, truncated: true, tokens: 0 };
  }
  const parts = loaded.map((t) =>
    formatToolForLoadedTail(t.name, t.summary, t.argsSchema, t.examples),
  );
  const full = parts.join("\n\n");
  const out = truncateToTokens(full, maxTokens);
  const tokens = estimateTokens(out);
  return {
    body: out.length > 0 ? out : null,
    truncated: out !== full,
    tokens,
  };
}
