import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelPick } from "../onboarding/local-model-picks.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { theme } from "../theme/theme.js";

/** Rows drawn at once; the rest are counted in a trailing line. */
export const LOCAL_PICK_WINDOW = 6;

/**
 * Pick a model to download. This used to be the Manage ▸ LLM panel —
 * tab strip, `kv —`, `tools 0ok/0err` and a `status: ready` header over
 * an install with nothing on disk. What a first run needs from that
 * screen is one decision, so this is that decision and nothing else.
 */
export function OnboardingLocalPickStep(props: {
  picks: readonly LocalModelPick[];
  cursor: number;
  ramGb: number;
  fit: OnboardingFit;
}): ReactElement {
  const start = Math.max(
    0,
    Math.min(props.cursor - LOCAL_PICK_WINDOW + 2, props.picks.length - LOCAL_PICK_WINDOW),
  );
  const visible = props.picks.slice(start, start + LOCAL_PICK_WINDOW);
  const below = props.picks.length - (start + visible.length);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.fit.explainer ? (
        <Box marginBottom={1}>
          <Text color={theme.colors.muted}>
            {`One download, then it runs offline. This machine reports ${props.ramGb} GB of RAM.`}
          </Text>
        </Box>
      ) : null}
      {visible.map((pick) => {
        const selected = props.picks[props.cursor]?.id === pick.id;
        return (
          <Text
            key={pick.id}
            color={selected ? theme.colors.accent : undefined}
            bold={selected}
            wrap="truncate"
          >
            {`${selected ? "›  " : "   "}${pick.label.padEnd(18)}${pick.sizeLabel.padStart(8)}    `}
            <Text color={noteColour(pick)}>{note(pick, props.fit)}</Text>
          </Text>
        );
      })}
      {below > 0 ? (
        <Text color={theme.colors.muted}>{`${" ".repeat(3)}↓ ${below} more`}</Text>
      ) : null}
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
