import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";
import type { McpAddModalState } from "../mcp/mcp-panel-state.js";
import { MultiLineEditor } from "./multi-line-editor.js";

export interface McpAddModalProps {
  state: McpAddModalState;
  onJsonChange: (next: string) => void;
  /**
   * Triggered when the operator submits the editor buffer. The
   * orchestrator validates + persists; failure surfaces as
   * `state.error` on the next render.
   */
  onSubmit: (json: string) => void;
  /** Triggered on Esc / Ctrl+C. The reducer closes the modal. */
  onCancel: () => void;
}

/**
 * Modal for pasting a single `McpServerConfig` JSON object.
 *
 * UX:
 *  - The MultiLineEditor owns its own Ink `useInput` while focused,
 *    so it captures every keystroke including paste-multiline.
 *  - Enter submits (MultiLineEditor's submit contract). The operator
 *    can still enter multi-line JSON by using paste — paste delivers
 *    the entire payload before the next Enter is read.
 *  - Esc cancels via `onEscape`.
 *
 * The modal is intentionally narrow: it accepts either a bare server
 * object or the `{ "mcpServers": { "name": {...} } }` Claude Desktop
 * envelope (unwrapped by `parseAddServerJson`).
 */
export function McpAddModal({
  state,
  onJsonChange,
  onSubmit,
  onCancel,
}: McpAddModalProps): ReactElement {
  // Width is pinned to 100% of the debug-pane column so the modal does
  // NOT resize itself to fit pasted content — every nested Box also
  // sets `width="100%"`. Without this Ink flexes everything to the
  // widest line of the pasted JSON, which makes the round border jump
  // around on every keystroke / paste burst.
  //
  // `MultiLineEditor` is rendered in `bare` mode so it does not add its
  // own inner border (the modal already owns the visible chrome). The
  // bare editor body is wrapped in a thin single-border Box so the
  // input area is still visually distinct from the surrounding hint
  // text.
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={
        state.error ? theme.colors.error : theme.colors.accentSoft
      }
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accent}>
        + add MCP server
      </Text>
      <Box marginTop={1} flexDirection="column" width="100%">
        <Text color={theme.colors.muted}>
          Paste one MCP server config as JSON. Bare object, or the
          Claude Desktop / Cursor envelope `{"{ \"mcpServers\": { ... } }"}`.
        </Text>
        <Text color={theme.colors.muted}>
          Top-level `command` + `args` (no `transport` wrapper) is also
          accepted and auto-promoted to stdio.
        </Text>
      </Box>
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="single"
        borderColor={
          state.error ? theme.colors.error : theme.colors.border
        }
        paddingX={1}
        width="100%"
      >
        <MultiLineEditor
          bare
          value={state.json}
          focus={!state.submitting}
          disabled={state.submitting}
          placeholder='{"mcpServers":{"github":{"command":"npx","args":["-y","@github/mcp-server"]}}}'
          onChange={onJsonChange}
          onSubmit={(buffer) => onSubmit(buffer)}
          onEscape={onCancel}
          onInterrupt={onCancel}
          // The modal raises the mouse floor; the field registers on the
          // modal layer so caret clicks and the right-click paste menu
          // still reach it.
          mouseLayer={MOUSE_LAYER_MODAL}
        />
      </Box>
      {state.error ? (
        <Box marginTop={1} width="100%">
          <Text color={theme.colors.error}>! {state.error}</Text>
        </Box>
      ) : null}
      {state.submitting ? (
        <Box marginTop={1} width="100%">
          <Text color={theme.colors.muted}>writing config…</Text>
        </Box>
      ) : null}
      <Box marginTop={1} width="100%">
        <Text color={theme.colors.muted}>
          Enter: submit · Shift/Alt+Enter: newline · Esc: cancel ·
          restart atomic-agent for the new server to connect
        </Text>
      </Box>
    </Box>
  );
}
