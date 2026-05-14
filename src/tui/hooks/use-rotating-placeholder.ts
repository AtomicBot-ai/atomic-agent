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
 */
export function useRotatingPlaceholder(
  phrases: readonly string[],
  intervalMs: number = 4000,
): string | undefined {
  const initial = phrases.length > 0 ? Math.floor(Math.random() * phrases.length) : 0;
  const [idx, setIdx] = useState<number>(initial);
  useEffect(() => {
    if (phrases.length <= 1) return;
    const handle = setInterval(() => {
      setIdx((prev) => (prev + 1) % phrases.length);
    }, intervalMs);
    return () => clearInterval(handle);
  }, [phrases, intervalMs]);
  if (phrases.length === 0) return undefined;
  const safeIdx = idx % phrases.length;
  return phrases[safeIdx];
}
