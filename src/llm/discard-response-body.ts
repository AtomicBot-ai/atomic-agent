/**
 * Let go of a response whose body nobody is going to read.
 *
 * Node's `fetch` is undici, and undici hands a connection back to its
 * pool only once the body has been consumed or cancelled; an unread one
 * holds it until the garbage collector finalises the `Response`. The
 * probes that only want a status line (`/health`, a key check on
 * `/props`, the supervisor's wedge watch on a non-OK `/slots`) run every
 * few seconds against the same local server, so each one cancels the
 * body it is not reading. Never throws, never waits: a body that is
 * already closed cancels as a no-op.
 */
export function discardResponseBody(response: Response | undefined): void {
  // Defensive about the shape: test doubles and embedders hand back
  // partial `Response`-likes, and a probe must not turn "answered" into
  // a throw because the stand-in had no body.
  const body = response?.body;
  if (!body || response?.bodyUsed === true) return;
  if (typeof body.cancel !== "function") return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A locked or already-errored stream: nothing left to release here.
  }
}
