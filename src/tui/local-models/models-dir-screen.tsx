import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { MultiLineEditor } from "../components/multi-line-editor.js";
import { useMouseCommands } from "../mouse/mouse-context.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";
import { modelsDirProgressLine, type ModelsDirPanelState } from "./models-dir-state.js";

/** Columns the long lines wrap at, like the Hugging Face editor's error box. */
const WRAP_COLUMNS = 72;

/**
 * ATO-2504: Models › models folder, the TUI's copy of Settings › Models ›
 * "Models folder" in the desktop app. Mounted by the Models tab and by
 * Manage › LLM › Local; its keys are `models-dir-keys.ts`, the move runs in
 * `models-dir-orchestrator.ts`. Loading, moving, error and the unplugged
 * disk are all drawn in the same place, under the folder line.
 */
export function ModelsDirScreen({ state }: { state: ModelsDirPanelState }): ReactElement {
  const mouse = useMouseCommands();
  const dispatch = mouse?.dispatch;
  const loading = state.dir === null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>Models folder</Text>
      {loading ? (
        <Text color={theme.colors.muted}>asking the agent where the models are…</Text>
      ) : (
        <Box width={WRAP_COLUMNS}>
          <Text wrap="wrap">
            Downloaded models are kept in <Text color={theme.colors.accent}>{state.dir}</Text>
            {state.custom ? "" : " (the default folder)"}.
          </Text>
        </Box>
      )}
      {!loading && !state.reachable ? (
        <Box width={WRAP_COLUMNS} marginTop={1}>
          <Text color={theme.colors.error} wrap="wrap">
            The disk with this folder is not connected, so your models cannot be used right now. Connect it, or press
            Enter on an empty line to use the default folder (the models stay on that disk).
          </Text>
        </Box>
      ) : null}
      {state.moving ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{modelsDirProgressLine(state.progress)}</Text>
          <Text color={theme.colors.muted}>
            {state.stopping ? "stopping, putting the models back…" : "across disks this copies every model and can take a while"}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.colors.muted}>
            {state.reachable
              ? "Type a new folder (empty, or new) to move every model there, for example on an external disk."
              : "Moving needs the disk connected."}
            {state.custom ? " Leave it empty to go back to the default folder." : ""}
          </Text>
          <MultiLineEditor
            value={state.draft}
            focus={!loading}
            disabled={loading}
            placeholder={state.custom ? "empty: the default folder" : "/Volumes/External/models"}
            onChange={(value) => dispatch?.({ type: "local_models_dir_draft_changed", value })}
            onSubmit={(value) => mouse?.callbacks.onLocalModelsDirMoveRequested?.(value)}
            onEscape={() => dispatch?.({ type: "local_models_dir_closed" })}
            mouseLayer={MOUSE_LAYER_PANEL}
          />
        </Box>
      )}
      {state.error ? (
        <Box width={WRAP_COLUMNS} marginTop={1}>
          <Text color={theme.colors.error} wrap="wrap">
            {state.error}
          </Text>
        </Box>
      ) : null}
      {state.note ? (
        <Box width={WRAP_COLUMNS} marginTop={1}>
          <Text color={theme.colors.success} wrap="wrap">
            {state.note}
          </Text>
        </Box>
      ) : null}
      <Text color={theme.colors.muted}>
        {state.moving ? (state.stopping ? "" : "esc stop the move") : "enter move · ctrl+l clear · esc back to the list"}
      </Text>
    </Box>
  );
}
