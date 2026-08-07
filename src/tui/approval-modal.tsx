import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ApprovalRequest } from "../approval/approval-gate.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
}

/**
 * Displayed as an in-place banner rather than a floating window to keep
 * rendering predictable across terminals. Hotkey handling lives at the
 * app root (`tui-app.tsx`) via ink's `useInput`.
 */
export function ApprovalModal({ request }: ApprovalModalProps): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        ⚠ approval required
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="gray">tool:    </Text>
          <Text bold>{request.tool}</Text>
        </Text>
        <Text>
          <Text color="gray">reason:  </Text>
          {request.reason}
        </Text>
        {request.preview ? (
          <Text>
            <Text color="gray">preview: </Text>
            {clip(request.preview, 240)}
          </Text>
        ) : null}
        {request.affectedResources && request.affectedResources.length > 0 ? (
          <Text>
            <Text color="gray">affects: </Text>
            {request.affectedResources.join(", ")}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="green">[y]</Text> approve   <Text color="red">[n]</Text> deny   <Text color="gray">[esc]</Text> abort run
        </Text>
      </Box>
      <Text color="gray">
        y approves this call only; turn approvals off on the Privacy tab
        (/privacy)
      </Text>
    </Box>
  );
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
