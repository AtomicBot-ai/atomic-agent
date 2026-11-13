import { describe, expect, it } from "vitest";

import { RENDER_HTML_EPOCH_MS, SYNC_ANIMATIONS_SCRIPT, frameTimeMs } from "./render-html-frames.js";

describe("render-html frames", () => {
  it("steps whole milliseconds that never drift from index / fps", () => {
    expect(frameTimeMs(0, 30)).toBe(0);
    expect(frameTimeMs(1, 30)).toBe(33);
    expect(frameTimeMs(2, 30)).toBe(67);
    expect(frameTimeMs(30, 30)).toBe(1000);
    expect(frameTimeMs(299, 30)).toBe(9967);
    expect(frameTimeMs(24, 24)).toBe(1000);
  });

  it("starts every render at the same fixed epoch", () => {
    expect(new Date(RENDER_HTML_EPOCH_MS).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("seeks each animation from the frame it was first seen in", () => {
    const made: Array<{ currentTime: number | null; paused: boolean; pause(): void }> = [];
    const animation = () => {
      const a = { currentTime: null as number | null, paused: false, pause() { a.paused = true; } };
      made.push(a);
      return a;
    };
    const first = animation();
    const live = [first];
    const window: Record<string, unknown> = {};
    const document = { getAnimations: () => live };
    // The script is page code; run it against a minimal window/document.
    const sync = new Function("window", "document", `return ${SYNC_ANIMATIONS_SCRIPT};`)(window, document) as (t: number) => void;
    sync(0);
    sync(100);
    expect(first).toMatchObject({ paused: true, currentTime: 100 });
    const later = animation();
    live.push(later);
    sync(200);
    sync(250);
    expect(first.currentTime).toBe(250);
    expect(later).toMatchObject({ paused: true, currentTime: 50 });
  });
});
