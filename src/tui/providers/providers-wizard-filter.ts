/**
 * Typed filter behind the wizard's three list screens.
 *
 * The provider list is 25 rows and the OpenRouter chat catalog runs past
 * 340; j/k twelve rows at a time was the only way to reach the far end
 * of either. The match is deliberately forgiving — case-insensitive,
 * whitespace-split, every term tried against the row's id and then its
 * rendered label — so "opus" finds `anthropic/claude-opus-5` by id and
 * "google" finds the Gemini row, which carries the vendor name only in
 * its label.
 */

/** A row a wizard list can match against: what it is, and what it reads as. */
export interface WizardFilterRow {
  readonly id: string;
  readonly label: string;
}

/** The query split into the terms a row must satisfy, all lowercased. */
export function searchTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * `true` when the row satisfies every term. Terms are ANDed so a second
 * word narrows rather than widens: on a 340-row catalog "qwen coder" has
 * to mean both, or the second word is wasted keystrokes.
 */
export function matchesSearchTerms(
  row: WizardFilterRow,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const id = row.id.toLowerCase();
  // `label` is a lazy getter on the catalog rows — it formats context
  // window, prices and capabilities — and the list is rebuilt on every
  // keystroke, so it is read only for the terms the id cannot answer.
  let label: string | null = null;
  for (const term of terms) {
    if (id.includes(term)) continue;
    label ??= row.label.toLowerCase();
    if (!label.includes(term)) return false;
  }
  return true;
}

/**
 * The rows a list shows for the current search box. `null` (closed box)
 * and an empty query both return the input array itself, so ordinary
 * j/k navigation never forces the lazy labels of a 340-row catalog.
 */
export function filterWizardRows<T extends WizardFilterRow>(
  rows: readonly T[],
  search: string | null,
): readonly T[] {
  const terms = search === null ? [] : searchTerms(search);
  if (terms.length === 0) return rows;
  return rows.filter((row) => matchesSearchTerms(row, terms));
}
