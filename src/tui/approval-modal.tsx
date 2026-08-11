import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import {
  formatApprovalCategory,
  isGrantableCategory,
} from "../approval/approval-level.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
}

/**
 * Displayed as an in-place banner rather than a floating window to keep
 * rendering predictable across terminals. Hotkey handling lives at the
 * app root (`tui-app.tsx`) via ink's `useInput`.
 */
export function ApprovalModal({ request }: ApprovalModalProps): ReactElement {
  const categoryLabel = formatApprovalCategory(request.category);
  // `[s]` for any grantable category (everything but trust_config);
  // `[a]` only when the shell tool supplied a command shape to grant.
  const grantCategory = isGrantableCategory(request.category);
  const grantShape =
    request.category === "shell" && Boolean(request.commandShape);
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
          <Text color="gray">kind:    </Text>
          {categoryLabel}
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
          <Text color="green">[y]</Text> approve{" "}
          {grantCategory ? (
            <>
              <Text color="cyan">[s]</Text> allow {categoryLabel} this session{" "}
            </>
          ) : null}
          {grantShape ? (
            <>
              <Text color="cyan">[a]</Text> allow all {request.commandShape}{" "}
              commands this session{" "}
            </>
          ) : null}
          <Text color="red">[n]</Text> deny   <Text color="gray">[esc]</Text> abort run
        </Text>
      </Box>
      <Text color="gray">{footerHint(grantCategory)}</Text>
    </Box>
  );
}

function footerHint(grantable: boolean): string {
  if (!grantable) {
    return "trust-config writes are never granted for the session; y approves this call only";
  }
  return "y approves this call once; s / a grant for this session only (never persisted); raise the standing level on the Privacy tab (/privacy)";
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
