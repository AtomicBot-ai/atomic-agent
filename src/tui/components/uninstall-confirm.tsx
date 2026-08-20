import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { UninstallConfirmState } from "../tui-state.js";

export interface UninstallConfirmProps {
  confirm: UninstallConfirmState;
}

/**
 * Confirmation overlay for `/uninstall`. Unlike the other y/n modals this
 * one renders the *actual plan* — every path that is about to be removed
 * — because "are you sure?" is not a fair question when the answer
 * depends on which of three scopes are in play.
 *
 * `s` toggles the state directory in and out of the plan. It defaults to
 * out: removing the program should not destroy the operator's sessions,
 * memory and API keys unless they say so. The wording turns red once it
 * is on, since that is the irreversible half.
 */
export function UninstallConfirm(props: UninstallConfirmProps): ReactElement {
  const { confirm } = props;

  if (confirm.done !== null) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.colors.accent}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={theme.colors.accent} bold>
          uninstall complete
        </Text>
        {confirm.done
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line, index) => (
            <Text key={`${index}-${line}`} color={theme.colors.muted}>
              {line}
            </Text>
          ))}
        <Text color={theme.colors.muted}>
          quit atomic-agent to finish · Esc / Enter = dismiss
        </Text>
      </Box>
    );
  }

  const borderColor = confirm.error
    ? theme.colors.error
    : confirm.includeState
      ? theme.colors.error
      : theme.colors.warn;

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={borderColor} bold>
        uninstall Atomic Agent?
      </Text>
      {confirm.preview
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}-${line}`} color={theme.colors.muted}>
            {line}
          </Text>
        ))}
      {confirm.includeState ? (
        <Text color={theme.colors.error}>
          ! state included — sessions, memory and API keys are erased for good
        </Text>
      ) : (
        <Text color={theme.colors.muted}>
          state directory is kept — reinstalling restores your sessions
        </Text>
      )}
      {confirm.error ? (
        <Text color={theme.colors.error}>! {confirm.error}</Text>
      ) : null}
      <Text color={theme.colors.muted}>
        {confirm.submitting
          ? "removing…"
          : `y = uninstall · s = ${confirm.includeState ? "keep" : "also erase"} state · n / Esc = cancel`}
      </Text>
    </Box>
  );
}
