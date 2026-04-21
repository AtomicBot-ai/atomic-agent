import { useEffect, useState } from "react";
import { theme } from "../theme/theme.js";

/**
 * React hook: returns the current spinner frame from the theme-configured
 * frame set, advancing on a fixed interval while `active` is true. When
 * inactive, the hook returns the first frame and does not schedule an
 * interval — safe to call unconditionally.
 */
export function useSpinner(active: boolean): string {
  const [frameIdx, setFrameIdx] = useState(0);
  useEffect(() => {
    if (!active) return;
    const handle = setInterval(
      () => setFrameIdx((prev) => (prev + 1) % theme.spinnerFrames.length),
      theme.spinnerFrameMs,
    );
    return () => clearInterval(handle);
  }, [active]);
  const safeIdx = Math.min(frameIdx, theme.spinnerFrames.length - 1);
  return theme.spinnerFrames[safeIdx] ?? theme.spinnerFrames[0] ?? " ";
}
