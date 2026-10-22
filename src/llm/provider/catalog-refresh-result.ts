/**
 * The outcome of a live catalog refresh (OpenRouter, AI/ML API). A failed
 * refresh keeps the bundled snapshot, which is still a useful answer, but
 * the reason is kept so a caller can log why the live list did not load:
 * a network error, the timeout, an HTTP status, or a body that is not the
 * expected JSON.
 */
export type CatalogRefreshResult = { ok: true } | { ok: false; reason: string };

/** A short reason for an error thrown while fetching or parsing a catalog. */
export function describeCatalogFetchError(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (err instanceof SyntaxError) return `response is not JSON: ${err.message}`;
  const code = (err as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string") return `network error ${code}`;
  return err.message;
}
