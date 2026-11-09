/**
 * The install the app runs by itself, tried again while the engine is taken.
 *
 * Why: `models update` never waits for the engine operation lock
 * (src/local-llm/core/core-backend.ts `installCoreBackend`, `waitMs: 0`), which
 * is right for someone who asked for it and is told at once. At launch and in
 * setup nobody asked: Studio's first call can be putting Core in place under
 * that same lock (studio-core-start.ts `ensureStudioCore`), and the install
 * then failed in seconds and left a red "Download failed" until Retry.
 */

/** How long the automatic install waits; the same patience as `withStudioOperation`. */
export const ENGINE_BUSY_WAIT_MS = 5 * 60_000;
const ENGINE_BUSY_POLL_MS = 3_000;

/** The agent's two refusals for a held lock (src/local-llm/core/core-operation.ts). */
const ENGINE_BUSY = /Another engine operation is (running|starting)/;

export function engineBusy(res: { ok: boolean; error?: string | null; stderr?: string | null }): boolean {
  return !res.ok && ENGINE_BUSY.test(`${res.error ?? ""}\n${res.stderr ?? ""}`);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run `attempt` until it is answered by anything but a held lock: success, a
 * real failure, a stop (`signal`) or the end of the wait, whose last refusal
 * is returned as it came.
 */
export async function retryWhileEngineBusy<T extends { ok: boolean; error?: string | null; stderr?: string | null }>(
  attempt: () => Promise<T>,
  opts: { signal: AbortSignal; waitMs?: number; pollMs?: number },
): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? ENGINE_BUSY_WAIT_MS);
  for (;;) {
    const res = await attempt();
    if (!engineBusy(res) || opts.signal.aborted || Date.now() >= deadline) return res;
    await pause(opts.pollMs ?? ENGINE_BUSY_POLL_MS, opts.signal);
    if (opts.signal.aborted) return res;
  }
}
