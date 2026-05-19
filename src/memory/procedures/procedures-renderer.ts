import type { ProcedureIndexEntry } from "./procedure-store.js";

/**
 * Memory-v2 phase 7b. Render the `### procedures` prompt section
 * as a **pointer view**: one compact line per active procedure,
 * carrying only `id`, optional tags, and the one-sentence
 * `activation`. The full `steps[]` body is **not** emitted here —
 * the agent must call `memory.procedures.recall { id }` to read it
 * (scenario 7b.C.3 + cross-phase invariant 22: procedures are
 * pointer-only in the prompt tail).
 *
 * Output shape (one line per procedure, prefixed with `>` so a
 * grep distinguishes them from `### lessons` rows):
 *
 *   ><id> [tags] activation gist
 *
 * `tags` segment is omitted when the procedure has no tags.
 * Returns `null` when there are no procedures to surface — the
 * build-prompt layer uses `null` to skip the section entirely.
 *
 * The `ProcedureIndexEntry` list already arrives ordered by
 * `vote_score DESC, updated_at DESC` from `ProcedureStore.listIndex`,
 * so the token-budget clip in `build-prompt` preserves the
 * highest-confidence rows when the section overflows
 * `memory.procedures.maxTokens` (scenario 7b.E.3).
 */
export function renderProceduresSection(
  procedures: readonly ProcedureIndexEntry[],
): string | null {
  if (procedures.length === 0) return null;
  return procedures.map(renderProcedureLine).join("\n");
}

function renderProcedureLine(entry: ProcedureIndexEntry): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : "";
  return `>${entry.id}${tags} ${escapeForLine(entry.activation)}`;
}

function escapeForLine(raw: string): string {
  if (!raw.includes("\n") && !raw.includes("\r")) return raw;
  return raw.replace(/\r?\n/g, " ").replace(/\r/g, " ");
}
