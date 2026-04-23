import type { ProfileFact } from "./profile-store.js";

/**
 * Render the contents of the `### profile` prompt section. This lives in
 * the variable tail of the prompt (never the stable prefix) so the KV
 * cache does not invalidate when the profile is edited between turns.
 *
 * Output format (stable, sorted by key):
 *   - language: ru
 *   - name: Alex
 *   - timezone: Europe/Moscow
 *
 * When the profile is empty we emit a sentinel line so downstream
 * budget/estimate code does not have to special-case the zero state.
 */
export function renderProfileSection(facts: readonly ProfileFact[]): string {
  if (facts.length === 0) return "(no profile)";
  const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
  return sorted.map((fact) => `- ${fact.key}: ${escapeValue(fact.value)}`).join("\n");
}

/**
 * Multi-line profile values are replaced with `\n` in the rendered line
 * so a single fact always occupies a single prompt line. Callers that
 * need the raw multi-line value should read it from the store directly.
 */
function escapeValue(raw: string): string {
  if (!raw.includes("\n") && !raw.includes("\r")) return raw;
  return raw.replace(/\r?\n/g, " \\n ").replace(/\r/g, " \\r ");
}
