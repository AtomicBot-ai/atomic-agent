import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";
import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { formatApprovalCategory } from "../approval/approval-level.js";
import { canEditPath, decideApproval } from "./app-key-bindings.js";
import { MultiLineEditor } from "./components/multi-line-editor.js";
import { theme } from "./theme/theme.js";
import { MouseTarget, useMouseCommands } from "./mouse/mouse-context.js";
import { isPrimaryPress } from "./mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "./mouse/mouse-registry.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
  /** Live target-path buffer, or `null` while the field is closed. */
  pathDraft: string | null;
  /** Clicking `[e]` — the key does the same via `handleApprovalKey`. */
  onPathOpen: () => void;
  onPathChange: (value: string) => void;
  onPathSubmit: (value: string) => void;
  onPathCancel: () => void;
}

/**
 * Displayed as an in-place banner rather than a floating window to keep
 * rendering predictable across terminals. Hotkey handling lives at the
 * app root (`tui-app.tsx`) via ink's `useInput`; the `[y]` / `[s]` /
 * `[a]` / `[n]` markers are also click targets, routed through the same
 * `decideApproval` the keys use.
 */
export function ApprovalModal({
  request,
  pathDraft,
  onPathOpen,
  onPathChange,
  onPathSubmit,
  onPathCancel,
}: ApprovalModalProps): ReactElement {
  const categoryLabel = formatApprovalCategory(request.category);
  // `[s]` for any grantable category (everything but trust_config);
  // `[a]` only when the shell tool supplied a command shape to grant.
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  const editable = canEditPath(request);
  const editing = pathDraft !== null;
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
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">target</Text>
          <Box
            borderStyle="round"
            borderColor={theme.colors.accent}
            paddingX={1}
          >
            <MultiLineEditor
              value={pathDraft ?? ""}
              focus
              bare
              onChange={onPathChange}
              onSubmit={onPathSubmit}
              onEscape={onPathCancel}
            />
          </Box>
          <Text color="gray">
            a target outside this workspace is re-checked and may ask again
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="green">enter</Text> confirm target path
            </Text>
            <Text>
              <Text color="gray">esc  </Text> back to the prompt
            </Text>
          </Box>
        </Box>
      ) : (
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
        {editable ? (
          <Box>
            <EditPathButton onOpen={onPathOpen}>
              <Text color="cyan">[e]</Text>
            </EditPathButton>
            <Text> edit target path…</Text>
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
      )}
      {editing ? null : (
        <Text color="gray">{footerHint(grantCategory)}</Text>
      )}
    </Box>
  );
}

function footerHint(grantable: boolean): string {
  // The composer stays live under this prompt, so the keys are only
  // keys while it is empty — an operator who starts typing is writing a
  // message, not answering y/n, and the hint has to say so or the
  // "why did y not work" report writes itself.
  const typing =
    "keys work while the input is empty — start typing to answer the agent instead (enter cancels this call and sends it)";
  if (!grantable) {
    return `trust-config writes are never granted for the session; y approves this call only · ${typing}`;
  }
  return `y approves this call once; s / a grant for this session only (never persisted); raise the standing level on the Privacy tab (/privacy) · ${typing}`;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/**
 * Click target for `[e]`. Defined inline (rather than reusing
 * `ApprovalButton`) because it opens the target field instead of
 * deciding the request — a click that resolved the approval here would
 * be the opposite of what the operator asked for.
 */
function EditPathButton({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: ReactNode;
}): ReactElement {
  const mouse = useMouseCommands();
  if (!mouse) return <>{children}</>;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onOpen();
        return true;
      }}
    >
      {children}
    </MouseTarget>
  );
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
