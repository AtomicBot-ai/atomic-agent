import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { rewindPreview } from "../../session/session-rewind.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { handleEditorSubmit } from "../submit-handler.js";
import { theme } from "../theme/theme.js";
import type { RewindChoiceState } from "../tui-state.js";
import { rewindScopeHint, rewindScopeLabel } from "./rewind-choice-state.js";
import { rewindChoiceNotes } from "./rewind-messages.js";

/**
 * `/rewind`, second step (ATO-2467): what to take back for the picked
 * message. Like Claude Code's "Restore code and conversation / Restore
 * conversation / Restore code": Up/Down move, Enter does it, Esc
 * cancels; a click selects, a second click (or Enter) does it. While the
 * files are checked the box keeps its shape and says so.
 */
export function RewindChoice({ choice }: { choice: RewindChoiceState }): ReactElement {
  const { point, facts, options, cursor } = choice;
  return (
    <Box borderStyle="round" borderColor={theme.colors.accent} paddingX={1} flexDirection="column">
      <Text color={theme.colors.muted}>
        rewind to #{point.ordinal} "{rewindPreview(point.text, 50) || "(empty message)"}" · Enter to choose · Esc to cancel
      </Text>
      {facts === null ? (
        <Text color={theme.colors.muted}>Checking which files would change…</Text>
      ) : (
        <>
          {options.map((scope, idx) => (
            <MouseListRow
              key={scope}
              layer={MOUSE_LAYER_MODAL}
              selected={idx === cursor}
              onSelect={(mouse) => mouse.dispatch({ type: "rewind_picker_cursor_set", row: idx })}
              onActivate={(mouse) => handleEditorSubmit("", mouse.getState(), mouse.dispatch, mouse.callbacks)}
            >
              <Box>
                <Text color={idx === cursor ? theme.colors.accentSoft : theme.colors.muted} bold={idx === cursor}>
                  {idx === cursor ? theme.glyphs.chevronRight : " "} {rewindScopeLabel(scope)}
                </Text>
                <Text color={theme.colors.muted}>
                  {"  "}
                  {rewindScopeHint(scope, facts.fileCount)}
                </Text>
              </Box>
            </MouseListRow>
          ))}
          {rewindChoiceNotes(facts).map((note) => (
            <Text key={note} color={theme.colors.muted}>
              {note}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
