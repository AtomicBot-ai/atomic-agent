import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import {
  useMouseCommands,
  useMouseTarget,
  type MouseContextValue,
} from "../mouse/mouse-context.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import {
  PasteFieldTarget,
  type PasteFieldTargetProps,
} from "../context-menu/paste-field-target.js";
import { pickWindowRows } from "./pick-list-geometry.js";
import { theme } from "../theme/theme.js";

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
 * The list's frame, and the only place in this file that may hold a
 * hook: `renderPickList` is a plain function its callers invoke
 * directly, not a component React renders, so hooks inside it are an
 * "Invalid hook call".
 *
 * Wheel over the list walks the cursor, one row a notch — the window is
 * derived from the cursor, so moving it *is* scrolling, the same model
 * `menu-popup.tsx` uses.
 *
 * It has to be here, at MODAL, rather than on the app's whole-viewport
 * wheel target: an open wizard raises the mouse floor to MODAL
 * (`isPanelModalOpen`), and the viewport target sits at the base layer,
 * so every wheel event over a wizard was dropped before anything saw
 * it. Hundreds of cloud models, and the only way down the list was the
 * arrow keys.
 *
 * It routes through `onSelect` — the very call a click on a row
 * makes — so wheel and click cannot drift into two different notions of
 * "select row N".
 */
function PickListFrame({
  cursor,
  total,
  onSelect,
  children,
}: {
  cursor: number;
  total: number;
  onSelect: (mouse: MouseContextValue, cursor: number) => void;
  children: ReactNode;
}): ReactElement {
  const mouse = useMouseCommands();
  const ref = useMouseTarget(
    (hit) => {
      if (hit.event.kind !== "wheel" || !hit.event.wheel || !mouse)
        return false;
      if (total === 0) return true;
      const delta = hit.event.wheel === "up" ? -1 : 1;
      const next = Math.min(Math.max(cursor + delta, 0), total - 1);
      if (next !== cursor) onSelect(mouse, next);
      // Claimed either way: at the ends of the list the notch has
      // nowhere to go, and letting it fall through would scroll the
      // chat behind the wizard instead.
      return true;
    },
    { layer: MOUSE_LAYER_MODAL },
  );
  return (
    <Box
      ref={ref}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      {children}
    </Box>
  );
}

/** Split a refusal at its first sentence end; the renderer caps it at two rows. */
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
export interface PickListProps {
  title: string;
  options: readonly { label: string }[];
  cursor: number;
  onSelect: (mouse: MouseContextValue, cursor: number) => void;
  onActivate: (mouse: MouseContextValue) => void;
  onPasteText: PasteFieldTargetProps["onPasteText"];
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
}

export function renderPickList(props: PickListProps): ReactElement {
  const total = props.options.length;
  const clamped = Math.min(Math.max(props.cursor, 0), Math.max(0, total - 1));
  const errors = props.error
    ? errorLines(props.error).slice(0, MAX_ERROR_ROWS)
    : [];
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
    <PickListFrame cursor={clamped} total={total} onSelect={props.onSelect}>
      <Text bold color={theme.colors.accent}>
        {props.title}
      </Text>
      {searchShown && props.search !== null ? (
        // Right-click paste only while the box is OPEN: on a closed box
        // a text burst would fall through to the list phase, where the
        // vim movement letters live. The owner supplies the paste route.
        <PasteFieldTarget onPasteText={props.onPasteText}>
          <Text color={theme.colors.muted} wrap="truncate-end">
            {"search: "}
            {/* `accent`, never `accentSoft`: the query is text the
                operator is actively reading, and the un-lifted fill sits
                near 2:1 against a dark ground (see theme-palettes.ts). */}
            <Text color={theme.colors.accent}>
              {props.search}
              <Text color={theme.colors.muted}>▏</Text>
            </Text>
          </Text>
        </PasteFieldTarget>
      ) : null}
      {searchShown && props.search === null ? (
        <Text color={theme.colors.muted} wrap="truncate-end">
          {"search: / to search"}
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
          /* First click selects; second activates through the owner's route.
             MODAL keeps row targets above the panel's mouse floor. */
          <MouseListRow
            key={`${index}-${opt.label}`}
            selected={index === clamped}
            layer={MOUSE_LAYER_MODAL}
            onSelect={(mouse) => props.onSelect(mouse, index)}
            onActivate={props.onActivate}
          >
            <Text
              color={index === clamped ? theme.colors.accent : undefined}
              wrap="truncate-end"
            >
              {mark} {opt.label}
            </Text>
          </MouseListRow>
        );
      })}
      {errors.map((line, i) => (
        <Text key={`err-${i}`} color={theme.colors.error} wrap="truncate-end">
          {i === 0 ? "! " : "  "}
          {line}
        </Text>
      ))}
      <Text color={theme.colors.muted} wrap="truncate-end">
        {props.moveHint} {position} · {props.actionsHint}
      </Text>
    </PickListFrame>
  );
}
