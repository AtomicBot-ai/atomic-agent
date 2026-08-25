import { useEffect, useState } from "react";

/**
 * React hook: cycles through a list of placeholder strings on a fixed
 * interval. The first phrase is picked at random on mount so two
 * sessions on the same machine do not always start with the same
 * suggestion. When the list has 0 or 1 entries the hook is inert (no
 * timer scheduled) and just returns the single value (or `undefined`).
 *
 * Used by the prompt shell to surface a rotating set of "what could I
 * ask?" hints in the empty-input state — mirrors the opencode prompt
 * `placeholders.normal` behaviour without depending on Solid signals.
 *
 * `active` is what stops it repainting the app for nothing. The
 * placeholder is drawn only while the composer is empty, but the timer
 * used to run regardless: from the first character typed the phrase was
 * invisible and the interval went on firing, and each fire is a
 * `setState` at the root of the tree — a full Ink frame, every four
 * seconds, for a string nobody could see. On a terminal that renders as
 * bytes arrive, a full frame is a visible flicker (see
 * `synchronized-output.ts`), so the cheapest repaint is the one that
 * never happens. Same shape as `useSpinner` and `useAtomField`, which
 * were already gated this way.
 */
export function useRotatingPlaceholder(
  phrases: readonly string[],
  intervalMs: number = 4000,
  active: boolean = true,
): string | undefined {
  const initial = phrases.length > 0 ? Math.floor(Math.random() * phrases.length) : 0;
  const [idx, setIdx] = useState<number>(initial);
  useEffect(() => {
    if (!active || phrases.length <= 1) return;
    const handle = setInterval(() => {
      setIdx((prev) => (prev + 1) % phrases.length);
    }, intervalMs);
    return () => clearInterval(handle);
  }, [active, phrases, intervalMs]);
  if (phrases.length === 0) return undefined;
  const safeIdx = idx % phrases.length;
  return phrases[safeIdx];
}
