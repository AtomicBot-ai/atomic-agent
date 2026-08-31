import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { getCurrentSection, type TuiSection } from "../section.js";
import { menuPlaceByTab } from "../menu/menu-registry.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { DownloadChip } from "./download-chip.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { getAppVersion } from "../../version.js";
import { Chip, tracked } from "./chip.js";
import { sessionTitleLine } from "./session-title.js";

interface StatusBarProps {
  state: TuiState;
  /**
   * Draw the `atomic-agent vX.Y.Z` lockup. False when the rail is on
   * screen: the rail already carries the brand and the version, and two
   * copies of them read as a rendering bug rather than as chrome.
   */
  brand?: boolean;
  /**
   * Draw the `»` that reopens a rail the operator folded away. True only
   * while the fold is the operator's own (`sidebarCollapsed`) AND the
   * terminal could seat the rail — when the size gate is what hid it,
   * there is nothing a click could restore, so no control is offered.
   * `TuiApp` computes the condition; the bar stays presentational.
   */
  railRestore?: boolean;
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
export function StatusBar({
  state,
  brand = true,
  railRestore = false,
}: StatusBarProps): ReactElement {
  const section = getCurrentSection(state);
  const title = currentSessionTitle(state);
  const { columns } = useTerminalSize();
  return (
    <Box>
      {railRestore ? <RailRestoreButton /> : null}
      {brand ? (
        <>
          <Text color={theme.colors.accentSoft} bold>
            atomic-agent
          </Text>
          <Text color={theme.colors.muted}> v{getAppVersion()}</Text>
          <Sep />
        </>
      ) : null}
      <Breadcrumb state={state} section={section} />
      <SessionTag sessionId={state.session.sessionId} />
      {state.localModelsPanel.pull ? (
        <DownloadChip
          pull={state.localModelsPanel.pull}
          budget={chipBudget(columns, brand, title)}
        />
      ) : null}
      {title ? (
        <Text color={theme.colors.muted}>
          {"  "}
          {theme.glyphs.dotSeparator}{" "}
          <Text color={theme.colors.assistant} bold>
            {title}
          </Text>
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * The preview of the session being worked on, which the design puts in
 * the top bar beside the id. Read from the rail's own session list so
 * the two can never disagree about what the current thread is called.
 */
/**
 * Columns the download chip may use: what is left of the row once the
 * brand lockup, the breadcrumb, the session tag and the title have had
 * theirs. Approximate on purpose — the point is to keep the bar on one
 * row, and Ink wraps rather than clips, so an over-long chip would turn
 * the header into a paragraph and push the whole app down the screen.
 */
function chipBudget(columns: number, brand: boolean, title: string | null): number {
  const BRAND = 22;
  const BREADCRUMB = 14;
  const SESSION_TAG = 18;
  const used =
    (brand ? BRAND : 0) + BREADCRUMB + SESSION_TAG + (title ? title.length + 4 : 0);
  return Math.max(0, columns - used - 2);
}

function currentSessionTitle(state: TuiState): string | null {
  const id = state.session.sessionId;
  if (!id) return null;
  // The rail's list, not the picker's: `sessionPickerList` is empty
  // until someone opens the picker, so reading it meant the title only
  // ever appeared after an unrelated detour through Ctrl+G U.
  const entry = state.recentSessions.find((row) => row.sessionId === id);
  // One line, always. Previews are stored as typed, so a multi-line
  // first prompt used to arrive here with its newlines intact and Ink
  // grew the bar to fit them — a one-row header became a paragraph and
  // pushed the rail, the chat and the composer down the screen.
  const title = sessionTitleLine(entry?.preview ?? "", TITLE_COLUMNS);
  return title.length > 0 ? title : null;
}

/** How much of the prompt the bar shows before it ellipsises. */
const TITLE_COLUMNS = 32;

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
      <Chip label={tracked(SECTION_LABELS[section])} tone="badge" />
      {tabLabel ? (
        <Text color={theme.colors.muted}>
          {/* The badge carries its own trailing pad; a second space here
              would set the breadcrumb a full cell off from every other
              separator in the bar. */}
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

/**
 * The way back after the rail's `«` folded it away. It sits at the head
 * of the bar — the cell nearest the corner the rail vacated — so the
 * fold and the unfold read as two positions of the same hinge. One
 * click brings the rail back; without mouse support the glyph stays as
 * a signpost to `/sidebar`, inert like every other chip.
 */
function RailRestoreButton(): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text>
      <Chip label={theme.glyphs.railRestore} />{" "}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({ type: "sidebar_collapse_toggled" });
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
  // The design sets this as `session <id>` in plain dim type, with a dot
  // before the title that follows — no pipe. One separator glyph in the
  // bar, used once, reads as punctuation; two read as a table.
  return (
    <Text>
      <Text color={theme.colors.muted}>{"   session "}</Text>
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
