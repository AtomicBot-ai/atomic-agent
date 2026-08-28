/**
 * The errno a failed request left behind.
 *
 * Node reports connection-level failures as an errno on the thrown
 * error (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, …) — and `undici`
 * buries it one level down, under the generic `TypeError: fetch failed`
 * it hands to `fetch` callers. Both HTTP clients here rebuild the
 * failure into their own typed error, which is where that errno used to
 * be dropped: `LlamaServerError(message, null, url)` says only "the
 * network failed", never *how*.
 *
 * That distinction is the whole diagnosis. `ECONNREFUSED` is "the daemon
 * was never started" — a setup problem. `ECONNRESET` mid-generation is
 * "the daemon died under us" — an OOM or a crash. `EAI_AGAIN` is DNS,
 * `ETIMEDOUT` is a hung box or a proxy. They need opposite fixes and
 * they all currently arrive looking identical.
 */

/** Node errnos are `E`-prefixed screaming snake; undici uses `UND_ERR_*`. */
const ERRNO_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/** Depth cap on the `cause` walk — a longer chain is a cycle. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The first errno-shaped `code` on `err` or in its `cause` chain.
 *
 * The shape check is not cosmetic: an arbitrary `code` field could be
 * freeform text, and this value is destined for an error report where
 * only enum-like scalars are allowed to travel.
 */
export function readErrnoCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && ERRNO_SHAPE.test(code)) return code;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}
