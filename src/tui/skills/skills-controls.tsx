import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { returnKey } from "../mouse/synthetic-key.js";
import { theme } from "../theme/theme.js";
import { handleSkillsTabKey } from "./skills-key-bindings.js";
import type { SkillsPanelState } from "./skills-panel-state.js";

/** Clicks dispatch the same commands as the displayed keyboard shortcuts. */
export function SkillsControls({ panel }: { panel: SkillsPanelState }): ReactElement {
  const actions = [
    ["w", "toggle in this project"],
    ["e", "toggle globally"],
    ["p", `project skills: ${panel.projectSkillsEnabled ? "on" : "off"}`],
  ];
  return <Box flexDirection="column">
    <Text color={theme.colors.muted}>Workspace: {panel.workspace}</Text>
    <Box gap={2}>
      {actions.map(([key, label]) => <MouseListRow key={key} selected onSelect={() => {}}
        onActivate={(mouse) => handleSkillsTabKey(key!, { ...returnKey(), return: false }, {
          state: mouse.getState(), dispatch: mouse.dispatch, callbacks: mouse.callbacks,
        })}>
        <Text color={theme.colors.accent}>[{key} {label}]</Text>
      </MouseListRow>)}
    </Box>
  </Box>;
}
