/**
 * The substring filter behind the composer's switch popup.
 *
 * The model switch lists whatever the active provider serves, and the
 * OpenRouter catalog runs past 340 rows in a ten-row window — the
 * arrows were the only way to reach the far end. The matching mirrors
 * the search the providers wizard grew in the cloud-search slice
 * (case-insensitive, whitespace-split, terms ANDed, each term tried
 * against the row's primary string and then its secondary one) so the
 * app's two type-to-filter surfaces cannot drift apart on what a query
 * means; fold the two helpers together once both slices are merged.
 */

/** A row the filter can match: what it reads as, and its second column. */
export interface SwitchFilterRow {
  readonly label: string;
  readonly detail: string;
}

/** The query split into the terms a row must satisfy, all lowercased. */
export function switchFilterTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * `true` when the row satisfies every term. Terms are ANDed so a second
 * word narrows rather than widens: on a 340-row catalog "qwen coder"
 * has to mean both, or the second word is wasted keystrokes.
 */
export function matchesSwitchFilter(
  row: SwitchFilterRow,
  terms: readonly string[],
): boolean {
  if (terms.length === 0) return true;
  const label = row.label.toLowerCase();
  // The detail is lowercased only for the terms the label cannot
  // answer: the list is rebuilt on every keystroke and most terms hit
  // the label (the model id) directly.
  let detail: string | null = null;
  for (const term of terms) {
    if (label.includes(term)) continue;
    detail ??= row.detail.toLowerCase();
    if (!detail.includes(term)) return false;
  }
  return true;
}

/** The rows left once the typed filter has had its say. */
export function filterSwitchRows<T extends SwitchFilterRow>(
  rows: readonly T[],
  filter: string,
): readonly T[] {
  const terms = switchFilterTerms(filter);
  if (terms.length === 0) return rows;
  return rows.filter((row) => matchesSwitchFilter(row, terms));
}
