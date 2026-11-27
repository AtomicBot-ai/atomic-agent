import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { widestLine } from "./centre-onboarding-block.js";
import type { OnboardingFit } from "./onboarding-fit.js";
import { handleOnboardingStepKey } from "./onboarding-step-keys.js";
import { ROW_MARKER, rowPrefix } from "./onboarding-rows.js";
import { ONBOARDING_CHOICES, type OnboardingChoice } from "./onboarding-state.js";
import { customDetailLine } from "./onboarding-local-servers.js";
import type { DetectedLocalServer } from "../../llm/provider/presets/detect-local-servers.js";
import { theme } from "../theme/theme.js";
import { t } from "../../i18n/index.js";

/**
 * The one decision the flow actually needs: where the model runs. The
 * copy describes a choice rather than reporting the failed health probe
 * that used to bring this screen up — a fresh install has nothing broken
 * about it, and "llama-server not reachable" as the first line a new user
 * reads says otherwise.
 */
/**
 * Label column. Wide enough for `Custom endpoint` plus a gap, so the
 * three details line up as a column of their own — a ragged left edge
 * there makes three comparable options read as three unrelated ones.
 */
const LABEL_COLUMNS = 20;

/**
 * Hand-wrapped rather than left to Ink: the block is centred on its
 * measured width, and a line that rewraps at a width the measure did
 * not predict would move the whole box.
 */
function explainerLines(): readonly string[] {
  return [t("onboarding.choose.explainer1"), t("onboarding.choose.explainer2")];
}

/** Where a choice row's detail column starts. */
const DETAIL_COLUMN = ROW_MARKER.length + LABEL_COLUMNS;

/**
 * The marker-and-label cell exactly as the row draws it. Shared by the
 * measure and the render so the two cannot disagree: the label is padded
 * out to the detail column only when a detail actually follows it —
 * blocks are centred on their measured width, and padding a line the
 * measure trims makes Ink wrap the invisible pad cells instead of
 * clipping them, growing the block taller than it was measured.
 */
function labelCell(
  selected: boolean,
  label: string,
  fit: OnboardingFit,
): string {
  return `${rowPrefix(selected)}${fit.rowDetails ? label.padEnd(LABEL_COLUMNS) : label}`;
}

/**
 * A row's first detail line. The Custom row names the local servers
 * found running here (ATO-2013); shared by the measure and the render.
 */
function firstDetail(
  choice: OnboardingChoice,
  detected: readonly DetectedLocalServer[] | undefined,
): string {
  return choice.id === "custom" ? customDetailLine(detected, choice.detail[0]) : choice.detail[0];
}

/** Widest line this step draws, for the block that centres it. */
export function measureOnboardingChooseStep(
  fit: OnboardingFit,
  detected?: readonly DetectedLocalServer[],
): number {
  const lines: string[] = fit.explainer ? [...explainerLines()] : [];
  for (const choice of ONBOARDING_CHOICES) {
    // Measured as selected: the marker and the indent are the same width.
    lines.push(
      `${labelCell(true, choice.label, fit)}${fit.rowDetails ? firstDetail(choice, detected) : ""}`,
    );
    if (fit.rowDetails)
      lines.push(`${" ".repeat(DETAIL_COLUMN)}${choice.detail[1]}`);
  }
  return widestLine(lines);
}

export function OnboardingChooseStep(props: {
  cursor: number;
  fit: OnboardingFit;
  /** Local servers found running here; the Custom row names them. */
  detected?: readonly DetectedLocalServer[];
}): ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.fit.explainer ? (
        <Box flexDirection="column" marginBottom={1}>
          {explainerLines().map((line) => (
            <Text key={line} color={theme.colors.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {ONBOARDING_CHOICES.map((choice, idx) => {
        const selected = idx === props.cursor;
        return (
          // First click selects, second activates — the same Enter the
          // keyboard sends, routed through the flow's own key table.
          <MouseListRow
            key={choice.id}
            selected={selected}
            onSelect={(mouse) =>
              mouse.dispatch({ type: "onboarding_cursor_set", cursor: idx })
            }
            onActivate={pressEnter(handleOnboardingStepKey)}
          >
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text
                  color={selected ? theme.colors.accent : undefined}
                  bold={selected}
                >
                  {labelCell(selected, choice.label, props.fit)}
                </Text>
                {props.fit.rowDetails ? (
                  <Text color={theme.colors.muted}>{firstDetail(choice, props.detected)}</Text>
                ) : null}
              </Box>
              {props.fit.rowDetails ? (
                <Text color={theme.colors.muted}>
                  {`${" ".repeat(DETAIL_COLUMN)}${choice.detail[1]}`}
                </Text>
              ) : null}
            </Box>
          </MouseListRow>
        );
      })}
    </Box>
  );
}
