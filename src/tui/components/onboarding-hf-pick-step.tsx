import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { ramWarningFor } from "../../local-llm/index.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import type { OnboardingHuggingFaceRepo } from "../onboarding/onboarding-state.js";
import { theme } from "../theme/theme.js";

/** Rows drawn at once, matching the curated picker's window. */
export const HF_PICK_WINDOW = 6;

/**
 * Widest of the deterministic lines this step draws, for the block that
 * centres it. The RAM warning and the error line are left out: both are
 * transient, and a block that re-centres itself when one appears would
 * jump under the cursor.
 */
export function measureOnboardingHfPickStep(
  repo: OnboardingHuggingFaceRepo | null,
  cursor: number,
): number {
  if (!repo) return 0;
  const { visible, below } = windowHfChoices(repo, cursor);
  const lines = [
    repo.repoId,
    ...visible.map(
      (choice) => `›  ${choice.filename.padEnd(44)}${choice.sizeLabel.padStart(9)}`,
    ),
  ];
  if (below > 0) lines.push(`   ↓ ${below} more`);
  if (repo.hidden) lines.push(`   ${repo.hidden}`);
  if (repo.mmproj) {
    lines.push("   vision projector in this repo — it is pulled alongside");
  }
  return widestLine(lines);
}

/** The rows actually on screen, shared between the render and the measure. */
function windowHfChoices(
  repo: OnboardingHuggingFaceRepo,
  rawCursor: number,
): { visible: OnboardingHuggingFaceRepo["choices"]; below: number; start: number } {
  const { choices } = repo;
  const cursor = Math.min(rawCursor, Math.max(0, choices.length - 1));
  const start = Math.max(
    0,
    Math.min(cursor - HF_PICK_WINDOW + 2, choices.length - HF_PICK_WINDOW),
  );
  const visible = choices.slice(start, start + HF_PICK_WINDOW);
  return { visible, below: choices.length - (start + visible.length), start };
}

/**
 * Which quantisation to pull. Only files this agent could actually serve
 * are listed; the line under the list says how many were left out and
 * why, so a repo that looks half-empty explains itself instead of
 * looking broken.
 *
 * The RAM line under the highlighted row warns and nothing more. Weights
 * larger than physical memory still load — llama.cpp maps the file and
 * the machine pages it — and an operator who knows their swap situation
 * is allowed to decide that is fine.
 */
export function OnboardingHuggingFacePickStep(props: {
  repo: OnboardingHuggingFaceRepo;
  cursor: number;
  ramGb: number;
  error: string | null;
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
        const active = start + index === cursor;
        return (
          <Text
            key={choice.path}
            color={active ? theme.colors.accent : undefined}
            bold={active}
            wrap="truncate"
          >
            {`${active ? "›  " : "   "}${choice.filename.padEnd(44)}${choice.sizeLabel.padStart(9)}`}
          </Text>
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
          {"   vision projector in this repo — it is pulled alongside"}
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
