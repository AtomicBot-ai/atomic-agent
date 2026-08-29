import { useEffect, useState } from "react";

/**
 * React hook: reveal `text` one character at a time, returning the
 * revealed prefix and whether it is finished.
 *
 * Modelled on `use-spinner.ts` — the `if (!active) return;` guard makes
 * it safe to call unconditionally, and the interval is cleared on
 * unmount. `skip` jumps to the full string, which is what a keypress
 * does: an animation nobody can interrupt is a wait, not a flourish.
 *
 * **One interval for the whole reveal.** An earlier version listed the
 * revealed count in the effect's dependencies, so every character tore
 * the timer down and armed a fresh one — with Ink's ~30fps commit in
 * between, a 45ms/char reveal actually crawled at ~230ms/char. The
 * count is advanced inside the tick instead, and the timer stops itself
 * on the last character.
 */
export function useTypewriter(
  text: string,
  options: { active: boolean; msPerChar: number; skip?: boolean },
): { revealed: string; done: boolean } {
  const { active, msPerChar, skip = false } = options;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active || skip) return;
    if (text.length === 0) return;
    const handle = setInterval(() => {
      setCount((prev) => {
        const next = prev + 1;
        if (next >= text.length) clearInterval(handle);
        return Math.min(next, text.length);
      });
    }, msPerChar);
    return () => clearInterval(handle);
  }, [active, msPerChar, skip, text.length]);

  // A skip has to land on the full length, not merely render as if it
  // had: otherwise the next tick would rewind the reveal.
  useEffect(() => {
    if (skip) setCount(text.length);
  }, [skip, text.length]);

  const revealed = skip ? text : text.slice(0, count);
  return { revealed, done: revealed.length >= text.length };
}
