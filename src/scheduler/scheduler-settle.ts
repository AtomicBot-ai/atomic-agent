/**
 * Wait for the scheduler's in-flight tick at `stop()`. Without `graceMs`
 * the wait is unbounded; with it, a tick whose turn ignores its abort
 * signal is left to finish on its own after `graceMs`. A rejection is
 * swallowed: `tickOnce` already logs it and records the metric.
 */
export async function settleWithGrace(
  inFlight: Promise<void> | null,
  graceMs: number | undefined,
): Promise<void> {
  if (!inFlight) return;
  const settled = inFlight.catch(() => {
    // tickOnce already logs + metrics the error
  });
  if (graceMs === undefined) {
    await settled;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
