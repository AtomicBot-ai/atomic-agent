import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { formatApprovalCategory } from "../approval/approval-level.js";
import { decideApproval } from "./app-key-bindings.js";
import { MouseTarget, useMouseCommands } from "./mouse/mouse-context.js";
import { isPrimaryPress } from "./mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "./mouse/mouse-registry.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
}

/**
 * Displayed as an in-place banner rather than a floating window to keep
 * rendering predictable across terminals. Hotkey handling lives at the
 * app root (`tui-app.tsx`) via ink's `useInput`; the `[y]` / `[s]` /
 * `[a]` / `[n]` markers are also click targets, routed through the same
 * `decideApproval` the keys use.
 */
export function ApprovalModal({ request }: ApprovalModalProps): ReactElement {
  const categoryLabel = formatApprovalCategory(request.category);
  // `[s]` for any grantable category (everything but trust_config);
  // `[a]` only when the shell tool supplied a command shape to grant.
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
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
      <Box marginTop={1} flexDirection="column">
        <Box>
          <ApprovalButton request={request} approved>
            <Text color="green">[y]</Text>
          </ApprovalButton>
          <Text> approve</Text>
        </Box>
        {grantCategory ? (
          <Box>
            <ApprovalButton request={request} approved grant="category">
              <Text color="cyan">[s]</Text>
            </ApprovalButton>
            <Text> allow {categoryLabel} this session</Text>
          </Box>
        ) : null}
        {grantShape ? (
          <Box>
            <ApprovalButton request={request} approved grant="shape">
              <Text color="cyan">[a]</Text>
            </ApprovalButton>
            <Text> allow all {request.commandShape} commands this session</Text>
          </Box>
        ) : null}
        <Box>
          <ApprovalButton request={request} approved={false}>
            <Text color="red">[n]</Text>
          </ApprovalButton>
          <Text> deny</Text>
        </Box>
        <Box>
          <Text color="gray">[esc]</Text>
          <Text> abort run</Text>
        </Box>
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

interface ApprovalButtonProps {
  request: ApprovalRequest;
  approved: boolean;
  grant?: ApprovalGrantScope;
  children: ReactNode;
}

/**
 * A clickable decision marker. Renders as plain text when the mouse
 * layer is absent, so the modal looks identical with `--no-mouse` and
 * under the test renderer.
 */
function ApprovalButton({
  request,
  approved,
  grant,
  children,
}: ApprovalButtonProps): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        decideApproval(request, approved, mouse, grant);
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
}
