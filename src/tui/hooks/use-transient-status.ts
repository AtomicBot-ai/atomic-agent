import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A status value that falls back to `idle` on its own after
 * `revertAfterMs` — the "label flips for two seconds, then reverts"
 * pattern the chat-log buttons are built on.
 *
 * The bookkeeping is fussier than it looks, which is why both buttons
 * share it rather than each carrying a copy:
 *
 *   - **The timer id lives in a ref.** The chat log repaints on every
 *     streamed token, so an id kept in component state is replaced
 *     mid-flight and the old timeout fires against a stale closure,
 *     stranding the label on its badge.
 *   - **A re-flash restarts the window** instead of stacking a second
 *     timeout behind it — otherwise the older timeout clears the badge
 *     early and the label blinks mid-feedback.
 *   - **Unmount clears it.** A message can scroll out of the ring buffer
 *     while its badge is still up.
 */
export function useTransientStatus<T>(
  idle: T,
  revertAfterMs: number,
): [T, (next: T) => void] {
  const [status, setStatus] = useState<T>(idle);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  // Read through a ref so `flash` never has to be re-created when the
  // caller passes a fresh object/array as the idle value.
  const idleRef = useRef(idle);
  idleRef.current = idle;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, []);
  const flash = useCallback(
    (next: T) => {
      if (!mountedRef.current) return;
      setStatus(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (mountedRef.current) setStatus(idleRef.current);
      }, revertAfterMs);
    },
    [revertAfterMs],
  );
  return [status, flash];
}
