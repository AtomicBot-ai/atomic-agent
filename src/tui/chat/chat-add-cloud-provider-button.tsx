import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import { theme } from "../theme/theme.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The dispatches that open the add-provider wizard on the Cloud pane.
 * A function, not a constant: every click gets a fresh wizard state.
 */
export function addCloudProviderActions(): readonly TuiAction[] {
  return [
    { type: "ui_mode_set", mode: "debug" },
    { type: "tab_changed", tab: "llm" },
    { type: "llm_mode_set", mode: "cloud" },
    {
      type: "providers_wizard_opened",
      wizard: createProvidersWizardState("add"),
    },
  ];
}

/**
 * The affordance on the "Cloud mode needs a cloud model" notice
 * (ATO-1460): the agent stayed on local because there is no cloud
 * provider, and this is the way to add one without knowing where the
 * LLM pane lives.
 *
 * Opens the same wizard the Cloud pane's "add" opens, so a provider
 * saved from here is saved exactly the way one added there would be.
 * It does not switch the mode afterwards: the operator picks Cloud or
 * Fusion again once the provider is in, which keeps "add a provider"
 * and "start spending on it" two separate decisions.
 *
 * Renders without a mouse provider too, like `[configure fallback]`.
 */
export function ChatAddCloudProviderButton(): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text color={theme.colors.muted} dimColor>
      [add cloud provider]
    </Text>
  );
  if (!mouse) return <Box marginLeft={1}>{label}</Box>;
  return (
    <Box marginLeft={1} flexDirection="row">
      <MouseTarget
        flexShrink={0}
        onMouse={(hit) => {
          if (!isPrimaryPress(hit.event)) return false;
          for (const action of addCloudProviderActions()) {
            mouse.dispatch(action);
          }
          return true;
        }}
      >
        {label}
      </MouseTarget>
    </Box>
  );
}
