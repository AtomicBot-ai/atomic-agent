import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import {
  HUGGING_FACE_ROW_LABEL,
  HUGGING_FACE_ROW_NOTE,
  type LocalModelPick,
} from "../onboarding/local-model-picks.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import { theme } from "../theme/theme.js";

/** Rows drawn at once; the rest are counted in a trailing line. */
export const LOCAL_PICK_WINDOW = 6;

/** Model-name column, wide enough for the catalog's longest id plus a gap. */
const LABEL_COLUMNS = 18;
/** Size column, right-aligned so the numbers compare down the column. */
const SIZE_COLUMNS = 8;
/** Gap between the size and the note that follows it. */
const NOTE_GAP = "    ";

function explainerLine(ramGb: number): string {
  return `One download, then it runs offline. This machine reports ${ramGb} GB of RAM.`;
}

function pickRow(pick: LocalModelPick, selected: boolean, fit: OnboardingFit): string {
  return (
    `${rowPrefix(selected)}${pick.label.padEnd(LABEL_COLUMNS)}` +
    `${pick.sizeLabel.padStart(SIZE_COLUMNS)}${NOTE_GAP}${note(pick, fit)}`
  );
}

function moreLine(below: number): string {
  return `${ROW_INDENT}↓ ${below} more`;
}

/**
 * The rows actually on screen, and how many are left below them. Shared
 * with the measure so the block is never sized for a row the list is
 * not drawing.
 */
export function windowLocalPicks(
  picks: readonly LocalModelPick[],
  cursor: number,
): { visible: readonly LocalModelPick[]; below: number; start: number } {
  const start = Math.max(
    0,
    Math.min(cursor - LOCAL_PICK_WINDOW + 2, picks.length - LOCAL_PICK_WINDOW),
  );
  const visible = picks.slice(start, start + LOCAL_PICK_WINDOW);
  return { visible, below: picks.length - (start + visible.length), start };
}

/** The pinned last row: the door out of the curated set. */
function huggingFaceRow(selected: boolean, fit: OnboardingFit): string {
  const note = fit.rowDetails ? `   ${HUGGING_FACE_ROW_NOTE}` : "";
  return `${rowPrefix(selected)}${HUGGING_FACE_ROW_LABEL}${note}`;
}

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingLocalPickStep(props: {
  picks: readonly LocalModelPick[];
  cursor: number;
  ramGb: number;
  fit: OnboardingFit;
}): number {
  const { visible, below } = windowLocalPicks(props.picks, props.cursor);
  const lines: string[] = props.fit.explainer ? [explainerLine(props.ramGb)] : [];
  lines.push("Recommended models");
  // Measured as if every row were selected: the marker is the same width
  // as the blank indent, so this only spares the caller a cursor lookup.
  for (const pick of visible) lines.push(pickRow(pick, true, props.fit));
  if (below > 0) lines.push(moreLine(below));
  lines.push(huggingFaceRow(true, props.fit));
  return widestLine(lines);
}

/**
 * Pick a model to download. This used to be the Manage ▸ LLM panel —
 * tab strip, `kv —`, `tools 0ok/0err` and a `status: ready` header over
 * an install with nothing on disk. What a first run needs from that
 * screen is one decision, so this is that decision and nothing else.
 *
 * The curated list is titled as a recommendation because that is what it
 * is; the row under it opens the whole of Hugging Face. That row is
 * pinned outside the scrolling window, since an operator who scrolled
 * past it would never learn it was there.
 */
export function OnboardingLocalPickStep(props: {
  picks: readonly LocalModelPick[];
  /** Index over the picks plus the trailing Hugging Face row. */
  cursor: number;
  ramGb: number;
  fit: OnboardingFit;
}): ReactElement {
  const onHuggingFace = props.cursor >= props.picks.length;
  const { visible, below, start } = windowLocalPicks(props.picks, props.cursor);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.fit.explainer ? (
        <Box marginBottom={1}>
          <Text color={theme.colors.muted}>{explainerLine(props.ramGb)}</Text>
        </Box>
      ) : null}
      <Text bold>Recommended models</Text>
      {visible.map((pick, index) => {
        const selected = !onHuggingFace && start + index === props.cursor;
        return (
          <Text
            key={pick.id}
            color={selected ? theme.colors.accent : undefined}
            bold={selected}
            wrap="truncate"
          >
            {`${rowPrefix(selected)}${pick.label.padEnd(LABEL_COLUMNS)}${pick.sizeLabel.padStart(SIZE_COLUMNS)}${NOTE_GAP}`}
            <Text color={noteColour(pick)}>{note(pick, props.fit)}</Text>
          </Text>
        );
      })}
      {below > 0 ? (
        <Text color={theme.colors.muted}>{moreLine(below)}</Text>
      ) : null}
      <Text
        color={onHuggingFace ? theme.colors.accent : undefined}
        bold={onHuggingFace}
        wrap="truncate"
      >
        {`${rowPrefix(onHuggingFace)}${HUGGING_FACE_ROW_LABEL}`}
        {props.fit.rowDetails ? (
          <Text color={theme.colors.muted}>{`   ${HUGGING_FACE_ROW_NOTE}`}</Text>
        ) : null}
      </Text>
    </Box>
  );
}

/**
 * What the row says after the size. RAM comes before the description
 * because it is the part that decides whether the model will run here —
 * and because the description is what truncation should eat first.
 */
function note(pick: LocalModelPick, fit: OnboardingFit): string {
  const parts: string[] = [];
  if (pick.recommended) parts.push("★ recommended");
  parts.push(pick.fit === "over" ? `needs ${pick.ramLabel}` : pick.ramLabel);
  if (fit.rowDetails) parts.push(pick.description);
  return parts.join(" · ");
}

/**
 * Colour says whether the machine can run it, so the row does not have
 * to be read twice: a model over the host's RAM is dimmed to the warn
 * tone rather than hidden — an operator who knows their swap situation
 * is allowed to pick it.
 */
function noteColour(pick: LocalModelPick): string {
  if (pick.fit === "over") return theme.colors.warn;
  if (pick.recommended) return theme.colors.success;
  return theme.colors.muted;
}
