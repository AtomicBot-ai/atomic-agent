import { Box, Text } from "ink";
import type { ReactElement } from "react";

import type { CodingMode } from "../coding-mode.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";

/**
 * What the operator does with a plan once it exists.
 *
 * Plan mode ends with a proposal and a dead end. The agent has said what
 * it would do and is forbidden from doing any of it, so carrying it out
 * meant two separate moves — find the mode control, change it, then
 * remember what you were going to say — with nothing on screen
 * connecting the plan to either. The plan is the *only* moment the next
 * step is obvious, and it was the one moment the app said nothing.
 *
 * Two buttons and a sentence, and the sentence matters as much as the
 * buttons: the third option is to keep planning, and an operator looking
 * at two "execute" buttons needs telling that typing is still allowed.
 *
 * **Why two rather than one plus a mode picker.** The choice at this
 * moment is not "which of four modes" — it is how much rope to give the
 * run that is about to start, and there are exactly two honest answers:
 * let it edit here and keep asking about everything else, or stop asking
 * altogether. Offering `default` would be offering to approve every step
 * of a plan already read and approved as a whole.
 */
export interface PlanHandoffProps {
  /** Runs the plan under `mode`. */
  onExecute: (mode: CodingMode) => void;
  /**
   * Puts the plan away without running it and without leaving plan
   * mode.
   *
   * The bar had two buttons and a sentence, and the sentence carried
   * the whole of the third option — which made "I do not want this
   * plan" the only choice with no control attached to it. Typing does
   * revise a plan, but it is not how you *drop* one, and an offer that
   * cannot be declined keeps sitting there.
   */
  onDismiss: () => void;
}

export function PlanHandoff({
  onExecute,
  onDismiss,
}: PlanHandoffProps): ReactElement {
  return (
    <Box flexDirection="column">
      {/*
        `flexWrap` rather than a width breakpoint. The bar sits inside
        the chat log now, in ordinary flow — so it is the log's column
        that decides how much room there is, and Yoga already knows
        that number. Measuring the terminal here and guessing a
        threshold was how the old version ended up painting its own
        second line over itself.
      */}
      <Box flexWrap="wrap">
        <ExecuteButton
          mode="auto"
          label="▶ run it · auto"
          tone={theme.colors.warn}
          onExecute={onExecute}
        />
        <Text> </Text>
        <ExecuteButton
          mode="bypass"
          label="▶ run it · bypass permissions"
          tone={theme.colors.error}
          onExecute={onExecute}
        />
        <Text> </Text>
        {/*
          Last, and in the quiet tone. It is the one button here that
          does nothing irreversible, and putting it first would give the
          least consequential choice the position the eye lands on.
        */}
        <DismissButton onDismiss={onDismiss} />
      </Box>
    </Box>
  );
}

function ExecuteButton({
  mode,
  label,
  tone,
  onExecute,
}: {
  mode: CodingMode;
  label: string;
  tone: string;
  onExecute: (mode: CodingMode) => void;
}): ReactElement {
  const face = (
    <Text backgroundColor={tone} color={readableOn(tone)} bold>
      {` ${label} `}
    </Text>
  );
  const mouse = useMouseCommands();
  // No mouse provider (tests, the wizard's separate tree): still draw
  // the face. It is the only thing on screen naming what happens next,
  // and a button that vanished without a mouse would take the
  // explanation with it.
  if (!mouse) return face;
  return (
    <MouseTarget
      flexShrink={0}
      layer={MOUSE_LAYER_PANEL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onExecute(mode);
        return true;
      }}
    >
      {face}
    </MouseTarget>
  );
}

function DismissButton({
  onDismiss,
}: {
  onDismiss: () => void;
}): ReactElement {
  const face = (
    <Text
      backgroundColor={theme.colors.badgeBackground}
      color={theme.colors.muted}
    >
      {" ✕ dismiss plan "}
    </Text>
  );
  const mouse = useMouseCommands();
  if (!mouse) return face;
  return (
    <MouseTarget
      flexShrink={0}
      layer={MOUSE_LAYER_PANEL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onDismiss();
        return true;
      }}
    >
      {face}
    </MouseTarget>
  );
}

/**
 * The message the buttons send.
 *
 * Written as an instruction rather than a bare "go", because the model
 * has just been told — by every refusal in the turn behind it — that its
 * tools do not work. Naming the change explicitly is what closes that
 * out; without it the likeliest next step is another plan.
 */
export const EXECUTE_PLAN_MESSAGE =
  "Carry out the plan you just described. Plan mode is off now, so your tools work again — go ahead and make the changes.";
