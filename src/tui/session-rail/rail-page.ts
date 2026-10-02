/**
 * How deep the rail reads into the session store, and when it reads
 * deeper.
 *
 * The store has no whole-table reader any more (see
 * `SessionStore.listSummaryPage`): the list is walked one page at a
 * time, and the rail asks for the first page only. Everything else is
 * on demand — the operator has to move the cursor to the bottom of what
 * is loaded before the next page is fetched.
 */

/**
 * Rows in one page. The rail paints at most `SIDEBAR_MAX_SESSION_ROWS`
 * (10) and the picker at most its own ten, so one page is four
 * screenfuls: the lookahead exists so the cursor never arrives at a
 * list that ends exactly where it stopped, and so the pinned block —
 * which rides on top of the page and takes slots from it — cannot
 * shrink the visible list below a screenful on its own.
 */
export const RAIL_PAGE_SIZE = 40;

/**
 * How close to the end of the loaded list the cursor has to get before
 * the next page is fetched. One page's worth of margin, so the fetch
 * happens while there is still a screenful below the cursor rather than
 * at the moment the operator hits the floor.
 */
export const RAIL_TAIL_MARGIN = 10;

/**
 * Is the cursor near enough to the end of `loaded` rows to want the
 * next page? `loaded === 0` is not — an empty rail has nothing to page
 * past, and asking would fire a store read on every arrow key in a
 * fresh install.
 */
export function railTailInView(cursor: number, loaded: number): boolean {
  if (loaded === 0) return false;
  return cursor >= loaded - RAIL_TAIL_MARGIN;
}
