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
  if (maxRows === undefined) return PICK_WINDOW;
  return Math.max(
    PICK_MIN_WINDOW,
    Math.min(PICK_WINDOW, maxRows - PICK_CHROME_ROWS - extraChromeRows),
  );
}

/** Most error lines the box will spend rows on. */
const MAX_ERROR_ROWS = 2;

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
   * Why the last action was refused. A list screen used to have nowhere
   * to say this, so a save the key check rejected looked exactly like a
   * keypress that did nothing — the whole of report #3.
   */
  error?: string | null;
}): ReactElement {
  const total = props.options.length;
  const clamped = Math.min(Math.max(props.cursor, 0), Math.max(0, total - 1));
  const errors = props.error ? errorLines(props.error).slice(0, MAX_ERROR_ROWS) : [];
  const window = pickWindowRows(props.maxRows, errors.length);
  const start = Math.min(
    Math.max(0, clamped - Math.floor(window / 2)),
    Math.max(0, total - window),
  );
  const visible = props.options.slice(start, start + window);
  const position = total === 0 ? "(0/0)" : `(${clamped + 1}/${total})`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accentSoft}>
        {props.title}
      </Text>
      {visible.map((opt, i) => {
        const index = start + i;
        const mark = index === clamped ? ">" : " ";
        return (
          <Text
            key={`${index}-${opt.label}`}
            color={index === clamped ? theme.colors.accentSoft : undefined}
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
