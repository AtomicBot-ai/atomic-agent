import type { Browser } from "playwright-core";

/**
 * The browser half of `video.render_html`: one PNG per frame of a page
 * whose time is ours, not the wall clock's.
 *
 * - Script time: Playwright's page clock (`page.clock`) fakes `Date`,
 *   `performance.now`, timers and `requestAnimationFrame`. It is
 *   installed and paused before the page loads, then moved forward by
 *   exactly one frame (`runFor`) before each screenshot, so a page that
 *   animates in `requestAnimationFrame` or on `setInterval` is captured
 *   at 0, 1/fps, 2/fps, ... however long a screenshot takes.
 * - CSS animations and transitions, and Web Animations, run on the
 *   document timeline, which the page clock does not touch. Before each
 *   screenshot every animation is paused and seeked to the frame's time
 *   (from when it was first seen), so they step in the same beat.
 *
 * `<video>`, GIFs and WebGL shaders that read the real time are not
 * controlled; the README says so.
 */

/** A fixed epoch for `Date.now()` inside the page, so two renders match. */
export const RENDER_HTML_EPOCH_MS = Date.UTC(2026, 0, 1);
const LOAD_TIMEOUT_MS = 30_000;

/**
 * Seek every animation the document has to virtual time `t` (ms since
 * the first frame), counted from the frame it was first seen in. A
 * string, evaluated in the page: this project compiles without DOM types.
 */
export const SYNC_ANIMATIONS_SCRIPT = `(t) => {
  const seen = window.__atomicRenderSeen || (window.__atomicRenderSeen = new WeakMap());
  for (const animation of document.getAnimations()) {
    if (!seen.has(animation)) seen.set(animation, t);
    try {
      animation.pause();
      animation.currentTime = Math.max(0, t - seen.get(animation));
    } catch (_) {}
  }
}`;

export type RenderSource = { kind: "file"; url: string } | { kind: "html"; html: string };

export interface CaptureFramesInput {
  launch: () => Promise<Browser>;
  source: RenderSource;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Handed each PNG in order; awaited, so ffmpeg's backpressure holds the capture. */
  onFrame: (png: Buffer, index: number) => Promise<void>;
  signal?: AbortSignal;
}

/** Virtual time of frame `i`, in whole milliseconds (the page clock ticks in ms). */
export function frameTimeMs(index: number, fps: number): number {
  return Math.round((index * 1000) / fps);
}

/**
 * Launch, load, capture every frame, close. Throws on a failed launch or
 * load with a message the tool hands the agent; a cancel throws the
 * signal's reason after closing the browser.
 */
export async function captureFrames(input: CaptureFramesInput): Promise<{ pageErrors: string[] }> {
  const browser = await input.launch();
  const pageErrors: string[] = [];
  const onAbort = (): void => { void browser.close().catch(() => {}); };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => {
      if (pageErrors.length < 10) pageErrors.push(err.message.split("\n")[0] ?? String(err));
    });
    // Installed and paused before the first document: the clock's log is
    // replayed into every document the page opens, so the page starts
    // frozen at the epoch and nothing moves until `runFor`.
    await page.clock.install({ time: RENDER_HTML_EPOCH_MS });
    await page.clock.pauseAt(RENDER_HTML_EPOCH_MS + 1_000);
    try {
      if (input.source.kind === "file") {
        await page.goto(input.source.url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      } else {
        await page.setContent(input.source.html, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
      }
    } catch (err) {
      throw new Error(`the page did not load: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    let previous = 0;
    for (let i = 0; i < input.frames; i++) {
      throwIfAborted(input.signal);
      const t = frameTimeMs(i, input.fps);
      if (t > previous) await page.clock.runFor(t - previous);
      previous = t;
      await page.evaluate(`(${SYNC_ANIMATIONS_SCRIPT})(${t})`);
      const png = await page.screenshot({ type: "png", caret: "hide", animations: "allow" });
      await input.onFrame(png, i);
    }
    return { pageErrors };
  } catch (err) {
    throwIfAborted(input.signal);
    throw err;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("cancelled");
}
