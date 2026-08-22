import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Largest viewport any wizard pick list will use, and the jump distance
 * for PgUp/PgDn in `providers-wizard-key-bindings`. Keep the two in sync
 * by importing this constant, never by copying the number.
 *
 * The rendered viewport shrinks below this on short terminals (see
 * `pickWindowRows`); the paging distance deliberately does not. PgDn is
 * "go a screenful further down a 300-row catalog", and pinning it to a
 * 3-row window on an 80x24 terminal would turn it into ↓↓↓.
 */
export const PICK_WINDOW = 12;

/** Never shrink the viewport below this — one row is not a list. */
export const PICK_MIN_WINDOW = 3;

/**
 * Rows the box spends on things that are not options: two border lines,
 * the top and bottom margins, the title, and the hint.
 */
const PICK_CHROME_ROWS = 6;

/**
 * How many option rows fit in `maxRows` total rows of terminal.
 *
 * `undefined` means "no budget was passed" and keeps the historical
 * fixed viewport. Callers that know the budget must pass it: Ink 7 does
 * not clip a frame taller than the terminal, it paints later lines over
 * earlier ones, so a 16-row box on an 11-row budget does not lose its
 * bottom — it eats whatever was above it.
 */
export function pickWindowRows(
  maxRows: number | undefined,
  extraChromeRows = 0,
): number {
  // The fixed viewport pays for extra chrome too: the unbudgeted callers
  // (first-run onboarding, the Providers panel) sized their screens to a
  // 12-option box, so a search or error line that ADDED a row instead of
  // taking one pushed their bottom row off a 24-row terminal.
  if (maxRows === undefined) {
    return Math.max(PICK_MIN_WINDOW, PICK_WINDOW - extraChromeRows);
  }
  return Math.max(
    PICK_MIN_WINDOW,
    Math.min(PICK_WINDOW, maxRows - PICK_CHROME_ROWS - extraChromeRows),
  );
}

/** Most error lines the box will spend rows on. */
const MAX_ERROR_ROWS = 2;

/**
 * What a list with nothing in it says. A bordered box with no rows reads
 * as a rendering fault; naming the query that emptied it, and the key
 * that undoes it, points at the fix instead.
 */
function emptyRowLine(search: string | null | undefined): string {
  if (search) return `no match for "${search}" — Backspace to widen it`;
  return "nothing to show here";
}

/**
 * Break a refusal into at most two truncated lines, split at the first
 * sentence end.
 *
 * The verdicts from `describeProviderVerifyOutcome` are two sentences —
 * what happened, then what to do about it — and run past 80 columns
 * together. Truncating the pair to one line keeps the verdict and throws
 * away the instruction, which is the half the operator needs. Splitting
 * on the sentence boundary is width-independent, so the box height stays
 * predictable at any terminal width.
 */
function errorLines(error: string): readonly string[] {
  const split = error.indexOf(". ");
  if (split === -1) return [error];
  return [error.slice(0, split + 1), error.slice(split + 2)];
}

/**
 * Movement and action hints for a filterable list, in its two states.
 *
 * The hint line is the only place either state is written down. Closed,
 * `j`/`k` move and `/` opens the search box. Open, every printable key
 * types into it, movement drops to the arrows, and Esc empties the box
 * before it will leave the screen — so the open form names both meanings
 * of Esc rather than letting the second one look like a dead key.
 */
export function pickListHints(
  search: string | null,
  actions: string,
  escClosed: string,
  escOpen: string,
): { moveHint: string; actionsHint: string } {
  if (search === null) {
    return {
      moveHint: "j/k move",
      actionsHint: `${actions} · / search · ${escClosed}`,
    };
  }
  return { moveHint: "↑/↓ move", actionsHint: `${actions} · ${escOpen}` };
}

/**
 * Bordered option list windowed around the cursor.
 *
 * Windowing lives here, not in the callers: the live OpenRouter/aimlapi
 * catalogs run past 300 rows, and an unwindowed map would paint them all
 * into the terminal at once.
 *
 * The hint line always starts with the movement keys and the position
 * counter (`j/k move (5/30) · ...`), for short lists too, matching the
 * original CompatChatModelStep shape. The counter is how the operator
 * knows where they are in a list the viewport cannot show whole, and a
 * counter that appears only past a size threshold reads as a glitch.
 */
export function renderPickList(props: {
  title: string;
  options: readonly { label: string }[];
  cursor: number;
  /** Movement-keys part of the hint, e.g. "j/k move". */
  moveHint: string;
  /** Actions part of the hint, e.g. "Enter select · Esc cancel". */
  actionsHint: string;
  /** Total terminal rows this box may occupy; omit for the fixed viewport. */
  maxRows?: number;
  /**
   * The search box above the options. Three states, not two: `undefined`
   * on a list that cannot be filtered (the compat picker, where typing
   * edits the model id instead), `null` on a filterable list whose box is
   * closed, and the query while it is open. A closed box still draws its
   * line — the operator has to be able to see that the list is
   * searchable before they would think to press `/`.
   */
  search?: string | null;
  /**
   * Why the last action was refused. A list screen used to have nowhere
   * to say this, so a save the key check rejected looked exactly like a
   * keypress that did nothing — the whole of report #3.
   */
  error?: string | null;
}): ReactElement {
  const total = props.options.length;
  const clamped = Math.min(Math.max(props.cursor, 0), Math.max(0, total - 1));
  const errors = props.error ? errorLines(props.error).slice(0, MAX_ERROR_ROWS) : [];
  const searchShown = props.search !== undefined;
  // The search line and the empty-list line are chrome for the row
  // budget in the same way the error lines are: Ink 7 paints an over-tall
  // frame over the rows above it rather than clipping.
  const chrome = errors.length + (searchShown ? 1 : 0) + (total === 0 ? 1 : 0);
  const window = pickWindowRows(props.maxRows, chrome);
  const start = Math.min(
    Math.max(0, clamped - Math.floor(window / 2)),
    Math.max(0, total - window),
  );
  const visible = props.options.slice(start, start + window);
  const position = total === 0 ? "(0/0)" : `(${clamped + 1}/${total})`;
  return (
    // The text here — title and cursor row — is ink and reads `accent`;
    // `accentSoft` is the house palette's *fill*, and as ink on a dark
    // terminal it lands near 2:1, which is what made this box and its
    // selection nearly unreadable. The border alone keeps the fill tone:
    // the brief fenced the lift to text, and the quiet frame leaves the
    // accent to the rows that are read.
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accent}>
        {props.title}
      </Text>
      {searchShown ? (
        <Text color={theme.colors.muted} wrap="truncate-end">
          {"search: "}
          {props.search === null ? (
            "/ to search"
          ) : (
            // `accent`, never `accentSoft`: the query is text the
            // operator is actively reading, and the un-lifted fill sits
            // near 2:1 against a dark ground (see theme-palettes.ts).
            <Text color={theme.colors.accent}>
              {props.search}
              <Text color={theme.colors.muted}>▏</Text>
            </Text>
          )}
        </Text>
      ) : null}
      {total === 0 ? (
        <Text color={theme.colors.muted} wrap="truncate-end">
          {emptyRowLine(props.search)}
        </Text>
      ) : null}
      {visible.map((opt, i) => {
        const index = start + i;
        const mark = index === clamped ? ">" : " ";
        return (
          <Text
            key={`${index}-${opt.label}`}
            color={index === clamped ? theme.colors.accent : undefined}
            wrap="truncate-end"
          >
            {mark} {opt.label}
          </Text>
        );
      })}
      {errors.map((line, i) => (
        <Text
          key={`err-${i}`}
          color={theme.colors.error}
          wrap="truncate-end"
        >
          {i === 0 ? "! " : "  "}
          {line}
        </Text>
      ))}
      <Text color={theme.colors.muted} wrap="truncate-end">
        {props.moveHint} {position} · {props.actionsHint}
      </Text>
    </Box>
  );
}
