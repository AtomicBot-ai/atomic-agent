import type { LaidOutSlide } from "./pptx-layout.js";
import type { PptxDeckSpec } from "./pptx-spec.js";

/**
 * ATO-2444: what a host needs to draw one slide of a deck as a thumbnail
 * while `os.fs.write_pptx` builds it. The text is clipped here, once, so
 * a 200-slide deck never floods the stream with whole paragraphs; the
 * thumbnail shows a handful of short lines anyway.
 */

/** Bullets a thumbnail shows; the slide may keep more. */
export const THUMB_BULLETS = 6;
/** Characters of a title, subtitle or bullet a thumbnail shows. */
export const THUMB_CHARS = 80;

/** The same shape as `ToolProgressSlide` on the agent's `tool_progress` event (agent-contract.ts). */
export interface PptxSlideProgress {
  index: number;
  count: number;
  layout: string;
  title: string;
  subtitle?: string;
  bullets: string[];
  visual?: "image" | "table" | "chart";
  moved: number;
  theme: string;
  accent?: string;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= THUMB_CHARS ? flat : `${flat.slice(0, THUMB_CHARS - 1).trimEnd()}…`;
}

export function slideProgressOf(
  laid: LaidOutSlide,
  index: number,
  spec: Pick<PptxDeckSpec, "slides" | "theme" | "accentColor">,
): PptxSlideProgress {
  const { slide } = laid;
  const visual =
    slide.image !== undefined ? "image" : slide.table !== undefined ? "table" : slide.chart !== undefined ? "chart" : undefined;
  return {
    index,
    count: spec.slides.length,
    layout: laid.layout,
    title: clip(slide.title),
    ...(slide.subtitle === undefined ? {} : { subtitle: clip(slide.subtitle) }),
    bullets: slide.bullets.slice(0, THUMB_BULLETS).map((b) => `${"  ".repeat(b.level)}${clip(b.text)}`),
    ...(visual === undefined ? {} : { visual }),
    moved: laid.moved,
    theme: spec.theme,
    ...(spec.accentColor === undefined ? {} : { accent: spec.accentColor }),
  };
}

/** The running card's (and the terminal feed's) line for that slide: "Slide 3 of 12 (two-column): Goals". */
export function slideProgressLabel(progress: PptxSlideProgress): string {
  return `Slide ${progress.index + 1} of ${progress.count} (${progress.layout}): ${progress.title}`;
}

export interface PptxProgressUpdate {
  fraction: number;
  elapsedMs: number;
  label: string;
  slide: PptxSlideProgress;
}

/**
 * The build's `onSlide` for a tool with an `onProgress` sink, or
 * undefined without one. A sink that throws never fails the deck.
 */
export function slideReporter(
  onProgress: ((sessionId: string, update: PptxProgressUpdate) => void) | undefined,
  sessionId: string,
  spec: Pick<PptxDeckSpec, "slides" | "theme" | "accentColor">,
  startedAt: number,
): ((laid: LaidOutSlide, index: number) => void) | undefined {
  if (onProgress === undefined) return undefined;
  return (laid, index) => {
    const slide = slideProgressOf(laid, index, spec);
    try {
      onProgress(sessionId, {
        fraction: (index + 1) / slide.count,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        label: slideProgressLabel(slide),
        slide,
      });
    } catch {
      // The deck is what was asked for; a host that cannot draw it changes nothing.
    }
  };
}
