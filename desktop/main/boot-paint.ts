/**
 * Backlog 03 — the first-run probe's frame log, summarised.
 *
 * preload.ts keeps one entry per change of view from the first animation
 * frame on: `blank` (nothing drawn yet), `chat` (the main window), `intro`
 * (the wizard's title card) and `wizard` (any later step). This turns it into
 * the two facts the item is about — was the chat window on screen before the
 * wizard, and did the title card leave with nobody touching it — measured
 * against the moment main showed the window, because a frame painted while
 * the window was still hidden is a frame nobody saw.
 *
 * Its own module, with no Electron import, so the unit tests can drive it.
 */

export type BootView = { view: string; at: number; frame: number };
export type BootPaintLog = {
  views: BootView[];
  frames: number;
  input: { type: string; at: number } | null;
  done: boolean;
};
export type BootPaintSummary = {
  frames: number;
  /** A frame of the chat window came before the wizard's first. */
  chatBeforeWizard: boolean;
  chatFrames: number;
  /** How long that chat window was on screen once the window was shown, in ms. */
  chatShownMs: number;
  /** The title card gave way to the next step with no input before it. */
  introLeftBySelf: boolean;
  /** Title card → next step, in ms; null while it never left. */
  introMs: number | null;
  /** The first input the window saw, if any — the probe itself sends none. */
  input: string | null;
  /** Every change of view, and the show, in ms from the first frame. */
  timeline: string;
};

export function summarizeBootPaint(log: BootPaintLog | null, shownAt: number | null, now = Date.now()): BootPaintSummary {
  const views = log?.views ?? [];
  const firstWizard = views.findIndex((v) => v.view === "intro" || v.view === "wizard");
  let chatFrames = 0;
  let chatShownMs = 0;
  for (let i = 0; i < (firstWizard < 0 ? views.length : firstWizard); i += 1) {
    const v = views[i]!;
    if (v.view !== "chat") continue;
    const next = views[i + 1];
    chatFrames += (next ? next.frame : (log?.frames ?? v.frame) + 1) - v.frame;
    if (shownAt !== null) chatShownMs += Math.max(0, (next ? next.at : now) - Math.max(v.at, shownAt));
  }
  const introAt = views.findIndex((v) => v.view === "intro");
  const leftAt = introAt < 0 ? -1 : views.findIndex((v, i) => i > introAt && v.view !== "intro");
  const left = leftAt < 0 ? null : views[leftAt]!;
  const input = log?.input ?? null;
  const t0 = views[0]?.at ?? 0;
  const marks = views.map((v) => ({ name: v.view, at: v.at }));
  if (shownAt !== null) marks.push({ name: "shown", at: shownAt });
  marks.sort((a, b) => a.at - b.at);
  return {
    frames: log?.frames ?? 0,
    chatBeforeWizard: chatFrames > 0,
    chatFrames,
    chatShownMs,
    introLeftBySelf: !!left && left.view === "wizard" && !(input && input.at <= left.at),
    introMs: left ? left.at - views[introAt]!.at : null,
    input: input ? input.type : null,
    timeline: marks.map((m) => `${m.name}+${m.at - t0}`).join(" "),
  };
}
