/**
 * Normalise a llama-server `--alias` (`/props.model_alias`) into a stable,
 * dashboard-friendly model tag for analytics. Operators pick arbitrary
 * aliases (`"A"`, `"Gemma 4 Think"`, ...), so the raw value pollutes the
 * `model` breakdown; this collapses it to a lowercase, hyphenated token
 * over a bounded charset.
 *
 * Returns `null` when the input is null/blank or reduces to an empty
 * string after stripping — the caller then falls through to the next
 * model-name source.
 */
export function sanitizeModelAlias(alias: string | null): string | null {
  if (alias === null) return null;
  const normalised = alias
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return normalised.length > 0 ? normalised : null;
}
