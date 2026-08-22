/**
 * The selection marker every first-run list row starts with.
 *
 * Four screens draw the same column of options, and each of them is
 * measured by `onboarding-surface-layout.ts` so the block around them can
 * be centred. Sharing the prefix is what keeps the measure and the
 * render from disagreeing about where a row's text begins.
 */
export const ROW_MARKER = "›  ";
/** The same width in blank cells, so unselected rows keep the column. */
export const ROW_INDENT = "   ";

export function rowPrefix(selected: boolean): string {
  return selected ? ROW_MARKER : ROW_INDENT;
}
