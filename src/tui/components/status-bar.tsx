import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { getCurrentSection, type TuiSection } from "../section.js";
import { menuPlaceByTab } from "../menu/menu-registry.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { getAppVersion } from "../../version.js";

interface StatusBarProps {
  state: TuiState;
}

/**
 * One-row operator status bar. Shows **where you are**, not where you could
 * go: the three-section pill row was a menu, and the menu now lives behind
 * `ctrl+p` where it can hold every destination instead of only the top three.
 * What is left is a breadcrumb — `Manage › Tasks` — which is the one thing
 * the popup cannot tell you, because you have to open it to read it.
 *
 * Replaces the legacy `header-line` +
 * `status-line` + `footer-line` trio: only signal that needs to be
 * visible at every glance stays on screen — current section and a
 * short session id when one exists. Verbose details (full cwd, llama
 * URL, KV cache %, tools ok/err counters, approval flag) live in the
 * Observe / Manage sections instead.
 *
 * Turn status (idle / working spinner) and LLM health (`● llm gemma`)
 * used to live here too — they moved into the `PromptShell` meta-row
 * so the operator's eyes stay near the input area instead of jumping
 * between the top bar and the prompt to read the live signal. See
 * [src/tui/components/prompt-meta-status.tsx](src/tui/components/prompt-meta-status.tsx).
 */
export function StatusBar({ state }: StatusBarProps): ReactElement {
  const section = getCurrentSection(state);
  return (
    <Box>
      <Text color={theme.colors.accentSoft} bold>
        atomic-agent
      </Text>
      <Text color={theme.colors.muted}> v{getAppVersion()}</Text>
      <Sep />
      <Breadcrumb state={state} section={section} />
      <SessionTag sessionId={state.session.sessionId} />
    </Box>
  );
}

const SECTION_LABELS: Record<TuiSection, string> = {
  run: "Run",
  observe: "Observe",
  manage: "Manage",
};

/**
 * Where you are: `Section › Tab`.
 *
 * #165 originally made a Run / Observe / Manage pill strip clickable, but
 * #170 replaced that strip with this breadcrumb — the menu is now the one
 * navigation surface, and re-adding pills would give the same job two
 * competing controls. So the breadcrumb itself takes the click and opens
 * the menu, which is exactly what `ctrl+p` does. Clicking where you
 * already are is still meaningful here: the menu is a destination list,
 * not a reset.
 */
function Breadcrumb({
  state,
  section,
}: {
  state: TuiState;
  section: TuiSection;
}): ReactElement {
  const mouse = useMouseCommands();
  const tabLabel =
    state.uiMode === "debug" ? menuPlaceByTab(state.activeTab)?.label : undefined;
  const label = (
    <Text>
      <Text color={theme.colors.accentSoft} bold>
        {SECTION_LABELS[section]}
      </Text>
      {tabLabel ? (
        <Text color={theme.colors.muted}>
          {" "}
          {theme.glyphs.chevronRight} <Text>{tabLabel}</Text>
        </Text>
      ) : null}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // Open at the top of the list, the same state `ctrl+p` produces,
        // so the keyboard and the mouse land on one menu rather than two
        // subtly different ones.
        mouse.dispatch({ type: "menu_path_set", path: null });
        mouse.dispatch({ type: "menu_cursor_set", cursor: 0 });
        mouse.dispatch({ type: "menu_opened" });
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

interface SessionTagProps {
  sessionId: string | null;
}

function SessionTag({ sessionId }: SessionTagProps): ReactElement | null {
  if (!sessionId) return null;
  return (
    <Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {theme.glyphs.pipeSeparator}
        {"  "}
        session{" "}
      </Text>
      <Text>{shortenId(sessionId)}</Text>
    </Text>
  );
}

function Sep(): ReactElement {
  return (
    <Text color={theme.colors.muted}>
      {"  "}
      {theme.glyphs.pipeSeparator}
      {"  "}
    </Text>
  );
}

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}
