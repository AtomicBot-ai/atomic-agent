import { Box, Text } from "ink";
import type { ReactElement } from "react";

import type { HuggingFaceRepoChoices } from "../../local-llm/index.js";
import { ramWarningFor } from "../../local-llm/index.js";
import type { MouseContextValue } from "../mouse/mouse-context.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { theme } from "../theme/theme.js";

/** Rows drawn at once, matching the curated picker's window. */
export const HF_PICK_WINDOW = 6;

/**
 * "Which quantisation to pull", as one list two flows share: the
 * first-run screen (`onboarding-hf-pick-step.tsx`) and the Models pane's
 * own add-a-model branch (`local-models-hf-panel.tsx`).
 *
 * Presentational on purpose — cursor movement and activation arrive as
 * callbacks — because the two flows keep their cursor in different
 * slices and route Enter through different key tables. What they must
 * not disagree about is what the list *says*: which files are offered,
 * what the line under it means when a repo looks half-empty, and when
 * the RAM warning appears.
 *
 * The RAM line warns and nothing more. Weights larger than physical
 * memory still load — llama.cpp maps the file and the machine pages it
 * — and an operator who knows their swap situation is allowed to decide
 * that is fine.
 */
export function HfPickList(props: {
  repo: HuggingFaceRepoChoices;
  cursor: number;
  ramGb: number;
  error: string | null;
  /** A click on a row that is not the current one. */
  onSelect(index: number, mouse: MouseContextValue): void;
  /**
   * A click on the row that already holds the cursor. Shaped like
   * `MouseListRow`'s own callback so a caller can hand it
   * `pressEnter(<its key table>)` and get the keyboard's Enter path for
   * free — which is the point: the mouse must not grow a second way to
   * start a download.
   */
  onActivate(mouse: MouseContextValue): void;
}): ReactElement {
  const { choices } = props.repo;
  const cursor = Math.min(props.cursor, Math.max(0, choices.length - 1));
  const { visible, below, start } = windowHfChoices(props.repo, props.cursor);
  const selected = choices[cursor];
  const warning = selected ? ramWarningFor(selected.fileSizeGb, props.ramGb) : null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>{props.repo.repoId}</Text>
      {visible.map((choice, index) => {
        const rowIndex = start + index;
        const active = rowIndex === cursor;
        return (
          // First click selects, second downloads — the same two steps
          // the keyboard takes.
          <MouseListRow
            key={choice.path}
            selected={active}
            onSelect={(mouse) => props.onSelect(rowIndex, mouse)}
            onActivate={props.onActivate}
          >
            <Text
              color={active ? theme.colors.accent : undefined}
              bold={active}
              wrap="truncate"
            >
              {hfChoiceLine(choice, active)}
            </Text>
          </MouseListRow>
        );
      })}
      {below > 0 ? (
        <Text color={theme.colors.muted}>{`${" ".repeat(3)}↓ ${below} more`}</Text>
      ) : null}
      {props.repo.hidden ? (
        <Text color={theme.colors.muted} wrap="truncate">
          {`   ${props.repo.hidden}`}
        </Text>
      ) : null}
      {props.repo.mmproj ? (
        <Text color={theme.colors.muted} wrap="truncate">
          {HF_MMPROJ_LINE}
        </Text>
      ) : null}
      {warning ? (
        <Text color={theme.colors.warn} wrap="truncate">{`   ⚠ ${warning}`}</Text>
      ) : null}
      {props.error ? (
        <Text color={theme.colors.error} wrap="truncate">{`   ${props.error}`}</Text>
      ) : null}
    </Box>
  );
}

export const HF_MMPROJ_LINE =
  "   vision projector in this repo — it is pulled alongside";

/** One row's text, shared with the onboarding block's width measure. */
export function hfChoiceLine(
  choice: HuggingFaceRepoChoices["choices"][number],
  active: boolean,
): string {
  return `${active ? "›  " : "   "}${choice.filename.padEnd(44)}${choice.sizeLabel.padStart(9)}`;
}

/** The rows actually on screen, shared between the render and the measure. */
export function windowHfChoices(
  repo: HuggingFaceRepoChoices,
  rawCursor: number,
): { visible: HuggingFaceRepoChoices["choices"]; below: number; start: number } {
  const { choices } = repo;
  const cursor = Math.min(rawCursor, Math.max(0, choices.length - 1));
  const start = Math.max(
    0,
    Math.min(cursor - HF_PICK_WINDOW + 2, choices.length - HF_PICK_WINDOW),
  );
  const visible = choices.slice(start, start + HF_PICK_WINDOW);
  return { visible, below: choices.length - (start + visible.length), start };
}
