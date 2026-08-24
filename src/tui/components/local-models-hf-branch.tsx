import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { handleLocalModelsHfKey } from "../local-models/local-models-hf-keys.js";
import type { LocalModelsPanelState } from "../local-models/local-models-panel-state.js";
import { useMouseCommands } from "../mouse/mouse-context.js";
import { pressEnter } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";
import { HfPickList } from "./hf-pick-list.js";
import { HfReferenceEditor } from "./hf-reference-editor.js";

/**
 * "Add a model from Hugging Face", inside the local-models pane. The screens
 * are the same two the first-run flow draws — `HfReferenceEditor` then
 * `HfPickList` — so a repo reference behaves identically whether the
 * operator names it during onboarding or a month later when they want a
 * second model. What differs is the slice the state lives on and the
 * key table Enter goes through (`local-models-hf-keys.ts`).
 *
 * Rendered without the pane's usual list footer: the hotkeys it
 * advertises are all inert here, and the branch states its own two.
 */
export function LocalModelsHuggingFaceBranch({
  panel,
}: {
  panel: LocalModelsPanelState;
}): ReactElement {
  const mouse = useMouseCommands();
  const dispatch = mouse?.dispatch;
  const { hf } = panel;
  if (panel.mode === "hfPick" && hf.repo) {
    return (
      <Box flexDirection="column">
        <HfPickList
          repo={hf.repo}
          cursor={hf.cursor}
          ramGb={panel.totalRamGb ?? 0}
          error={hf.error}
          onSelect={(cursor, m) =>
            m.dispatch({ type: "local_models_hf_cursor_set", cursor })
          }
          onActivate={pressEnter(handleLocalModelsHfKey)}
        />
        <Text color={theme.colors.muted}>
          j/k move · Enter download · esc back
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <HfReferenceEditor
        value={hf.reference}
        busy={hf.busy}
        error={hf.error}
        onChange={(value) =>
          dispatch?.({ type: "local_models_hf_reference_changed", value })
        }
        onSubmit={(value) =>
          mouse?.callbacks.onLocalModelsHfResolveRequested?.(value)
        }
        onClear={() =>
          dispatch?.({ type: "local_models_hf_reference_changed", value: "" })
        }
        onEscape={() => dispatch?.({ type: "local_models_hf_closed" })}
        mouseLayer={MOUSE_LAYER_PANEL}
      />
      <Text color={theme.colors.muted}>
        {hf.busy
          ? "esc cancel"
          : "enter look it up · ctrl+l clear · esc back to the list"}
      </Text>
    </Box>
  );
}
