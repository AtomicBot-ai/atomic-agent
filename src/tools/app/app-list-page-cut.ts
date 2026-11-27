/** The line app.list puts over a page it sends whole. */
export const APP_LIST_WHOLE_PAGE_LINE = "current page:";

/**
 * What replaces {@link APP_LIST_WHOLE_PAGE_LINE} when a batched step's
 * shared budget (batch-summary-cap.ts) clips an app.list result: the
 * tool sized the page for a step of its own, so the model must not take
 * the clipped page as whole and send it back through app.update.
 */
export function appListCutInBatchLine(capChars: number): string {
  return `current page (cut: this step's results share a ${capChars}-char budget; app.update needs the whole page, so call app.list with this id alone first):`;
}

/**
 * Clip an app.list result to `share` with `clip`, and say on its header
 * line that the page is cut. Leaf file: the agent imports it, so it
 * imports nothing.
 */
export function clipAppListSummary(
  summary: string,
  share: number,
  capChars: number,
  clip: (summary: string, share: number) => string,
): string {
  const whole = `\n${APP_LIST_WHOLE_PAGE_LINE}\n`;
  if (!summary.includes(whole)) return clip(summary, share);
  const cut = `\n${appListCutInBatchLine(capChars)}\n`;
  return clip(summary, Math.max(1, share - (cut.length - whole.length))).replace(whole, cut);
}
