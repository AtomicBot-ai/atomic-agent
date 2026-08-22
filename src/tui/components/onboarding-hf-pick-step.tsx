import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { ramWarningFor } from "../../local-llm/index.js";
import type { OnboardingHuggingFaceRepo } from "../onboarding/onboarding-state.js";
import { theme } from "../theme/theme.js";

/** Rows drawn at once, matching the curated picker's window. */
export const HF_PICK_WINDOW = 6;

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
  const start = Math.max(
    0,
    Math.min(cursor - HF_PICK_WINDOW + 2, choices.length - HF_PICK_WINDOW),
  );
  const visible = choices.slice(start, start + HF_PICK_WINDOW);
  const below = choices.length - (start + visible.length);
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
