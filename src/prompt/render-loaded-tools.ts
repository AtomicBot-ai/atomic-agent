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

/**
 * Renders `### loaded-tools` body from `session.loadedTools`, capped by
 * `maxTokens` (estimated).
 */
export function renderLoadedToolsSection(
  session: SessionState,
  maxTokens: number,
): RenderedLoadedTools {
  if (!session.loadedTools || session.loadedTools.length === 0) {
    return { body: null, truncated: false, tokens: 0 };
  }
  if (maxTokens <= 0) {
    return { body: null, truncated: true, tokens: 0 };
  }
  const parts = session.loadedTools.map((t) =>
    formatToolForLoadedTail(
      t.name,
      t.summary,
      t.argsSchema,
      t.examples,
    ),
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
