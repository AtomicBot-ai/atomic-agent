/**
 * The provider id a refused-key error names, for the `[check key]`
 * button (ATO-1457).
 *
 * A provider's HTTP error carries the provider id it was raised for
 * (`OpenAiHttpError.providerLabel`). The turn's error can wrap it (a
 * fallback chain that ran out, a retry wrapper), so the `cause` chain
 * is walked a few levels. Read by shape, not by class, so the reducer
 * does not import a provider module. `undefined` when no level names
 * one: the button then opens the active provider.
 */
export function rejectedKeyProviderId(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
    const label = (current as { providerLabel?: unknown }).providerLabel;
    if (typeof label === "string" && label.length > 0) return label;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
