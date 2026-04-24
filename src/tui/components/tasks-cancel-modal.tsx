import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TaskCancelConfirmState } from "../tasks/tasks-panel-state.js";

export interface TasksCancelModalProps {
  confirm: TaskCancelConfirmState;
}

/**
 * Y/N confirmation modal shown before a recurring task is cancelled.
 * One-shot tasks skip this modal and go straight through the cancel
 * path — see the keybinding layer. Rendering is identical to an inline
 * warning block so the modal stacks naturally under the editor.
 */
export function TasksCancelModal(props: TasksCancelModalProps): ReactElement {
  const { confirm } = props;
  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.warn}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.warn} bold>
        cancel {confirm.isRecurring ? "recurring" : ""} task?
      </Text>
      <Text>
        <Text color={theme.colors.muted}>id:</Text> {confirm.taskId}
      </Text>
      <Text color={theme.colors.muted}>
        this stops all future firings. y = confirm · n / Esc = keep
      </Text>
    </Box>
  );
}
