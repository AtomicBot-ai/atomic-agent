/** Shared logo rendering contract; independent of start-page layout. */
export type LogoVariant = "full" | "small" | "mini" | "tiny";
/**
 * Where the wordmark goes relative to the mark. `full` is 51 columns
 * wide — parking a 46-column wordmark beside it needs 100 columns of
 * chat surface, which is a 140-column terminal. Stacking it underneath
 * needs only the mark's own width, so the big mark keeps its name on
 * ordinary terminals instead of going anonymous above 100 columns.
 */
export type WordmarkPlacement = "beside" | "below" | "none";
