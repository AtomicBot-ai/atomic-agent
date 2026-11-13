import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { configureWizardKindForRow } from "../providers/providers-orchestrator.js";
import { openProviderConfigFor } from "../llm-panel/llm-panel-primary-actions.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiState } from "../tui-state.js";
import { theme } from "../theme/theme.js";

interface ChatCheckKeyButtonProps {
  /** The provider that refused the key, when the error named it. */
  readonly providerId?: string;
}

/**
 * Put the operator on the key field of the provider that refused it:
 * Manage > LLM > Cloud, with that provider's configure wizard open on
 * its API key step (the step `createProvidersWizardState("configure")`
 * starts on). When the named provider is not a configurable row, the
 * active cloud provider is used, the same pick Enter on the Cloud pane
 * makes; with neither, the Cloud pane alone.
 */
export function dispatchCheckKey(
  state: TuiState,
  dispatch: (action: TuiAction) => void,
  providerId: string | undefined,
): void {
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: "llm" });
  dispatch({ type: "llm_mode_set", mode: "cloud" });
  const rows = state.providersPanel.rows;
  const configurable = (row: (typeof rows)[number]): boolean =>
    configureWizardKindForRow(row) !== null;
  const row =
    rows.find((r) => r.id === providerId && configurable(r)) ??
    rows.find((r) => r.isActiveText && configurable(r));
  if (row) openProviderConfigFor(row, dispatch);
}

/**
 * The affordance on a turn that failed because the provider refused the
 * API key (ATO-1457).
 *
 * The notice says "The provider did not accept your API key." and a
 * refused key never fixes itself: retrying fails the same way, and
 * picking another model on the same provider does too. The fix is one
 * field in a wizard most operators reach only through `/llm`, a pane
 * and Enter; the button is that path in one click.
 *
 * Without a mouse provider it renders as a `/llm` hint instead, the
 * way there under `--no-mouse`.
 */
export function ChatCheckKeyButton({
  providerId,
}: ChatCheckKeyButtonProps): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) {
    return (
      <Box marginLeft={1}>
        <Text color={theme.colors.muted} dimColor>
          check the key in /llm
        </Text>
      </Box>
    );
  }
  return (
    <Box marginLeft={1} flexDirection="row">
      <MouseTarget
        flexShrink={0}
        onMouse={(hit) => {
          if (!isPrimaryPress(hit.event)) return false;
          dispatchCheckKey(mouse.getState(), mouse.dispatch, providerId);
          return true;
        }}
      >
        <Text color={theme.colors.muted} dimColor>
          [check key]
        </Text>
      </MouseTarget>
    </Box>
  );
}
