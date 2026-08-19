import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { EventFeed } from "../event-feed.js";
import { LogsTab } from "../logs-tab.js";
import { ReasoningTab } from "../reasoning-tab.js";
import { WorldPanel } from "../world-panel.js";
import {
  getCurrentSection,
  MANAGE_TABS,
  OBSERVE_TABS,
  type TuiSection,
} from "../section.js";
import { theme } from "../theme/theme.js";
import type { TuiState, TuiTab } from "../tui-state.js";
import { DebugDiagnosticsLine } from "./debug-diagnostics-line.js";
import { LocalLlmLogsPanel } from "./local-llm-logs-panel.js";
import { LocalModelsPanel } from "./local-models-panel.js";
import { LlmPanel } from "./llm-panel.js";
import { TasksPanel } from "./tasks-panel.js";
import { SkillsPanel } from "./skills-panel.js";
import { McpPanel } from "./mcp-panel.js";
import { MemoryPanel } from "./memory-panel.js";
import { ImportPanel } from "./import-panel.js";
import { TelegramPanel } from "../telegram/components/telegram-panel.js";
import { PrivacyPanel } from "../privacy/components/privacy-panel.js";
import { ProvidersPanel } from "./providers-panel.js";

interface DebugPaneProps {
  state: TuiState;
  maxVisible: number;
  onMcpAddJsonChange?: (json: string) => void;
  onMcpAddSubmit?: (json: string) => void;
  onMcpAddCancel?: () => void;
}

/**
 * Container rendered in place of the chat log whenever `uiMode ===
 * "debug"`. Only the inner tabs of the **current section** are surfaced
 * — operators no longer see all nine debug + admin tabs in one bar.
 *
 * The active section is derived from `state` (see `section.ts`), so
 * existing slash commands (`/feed`, `/tasks`, …) keep working: each one
 * sets `activeTab`, which in turn implies which sub-tab strip is shown.
 */
export function DebugPane({
  state,
  maxVisible,
  onMcpAddJsonChange,
  onMcpAddSubmit,
  onMcpAddCancel,
}: DebugPaneProps): ReactElement {
  const section = getCurrentSection(state);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <SubTabBar state={state} section={section} />
      <DebugDiagnosticsLine state={state} />
      <ActiveDebugTab
        state={state}
        maxVisible={maxVisible}
        onMcpAddJsonChange={onMcpAddJsonChange}
        onMcpAddSubmit={onMcpAddSubmit}
        onMcpAddCancel={onMcpAddCancel}
      />
    </Box>
  );
}

interface SubTabBarProps {
  state: TuiState;
  section: TuiSection;
}

function SubTabBar({ state, section }: SubTabBarProps): ReactElement | null {
  if (section === "run") return null;
  const tabs =
    section === "manage" ? buildManageTabs(state) : buildObserveTabs(state);
  return (
    <Box flexWrap="wrap">
      {tabs.map((tab, idx) => (
        <Box key={tab.id} flexShrink={0}>
          <SubTabLabel tab={tab} active={tab.id === state.activeTab} />
          {idx < tabs.length - 1 ? (
            <Text color={theme.colors.muted}>
              {"  "}
              {theme.glyphs.pipeSeparator}
              {"  "}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

/**
 * One sub-tab. Split out of the strip so each label owns a measurable
 * box the mouse layer can hit — clicking a tab performs the same
 * dispatch Tab-cycling does.
 */
function SubTabLabel({
  tab,
  active,
}: {
  tab: SubTab;
  active: boolean;
}): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text
      color={active ? theme.colors.accentSoft : theme.colors.muted}
      bold={active}
    >
      {active ? `${theme.glyphs.chevronRight} ` : "  "}
      {tab.label}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_PANEL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        if (!active) mouse.dispatch({ type: "tab_changed", tab: tab.id });
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

interface SubTab {
  id: TuiTab;
  label: string;
}

function buildObserveTabs(state: TuiState): SubTab[] {
  return [
    { id: "feed", label: `Feed${suffix(state.feed.length)}` },
    { id: "world", label: "World" },
    { id: "reasoning", label: `Reasoning${suffix(state.reasoning.length)}` },
    { id: "logs", label: `Logs${suffix(state.logs.length)}` },
    { id: "llm-logs", label: "LLM logs" },
  ];
}

function buildManageTabs(state: TuiState): SubTab[] {
  return [
    { id: "tasks", label: `Tasks${suffix(state.tasksPanel.rows.length)}` },
    { id: "skills", label: `Skills${suffix(state.skillsPanel.rows.length)}` },
    { id: "memory", label: `Memory${suffix(state.memoryPanel.rows.length)}` },
    { id: "mcp", label: `MCP${suffix(state.mcpPanel.rows.length)}` },
    { id: "llm", label: "LLM" },
    { id: "telegram", label: telegramTabLabel(state) },
    { id: "import", label: "Import" },
    { id: "privacy", label: "Privacy" },
  ];
}

/**
 * Height consumed by the always-on app frame OUTSIDE the debug pane:
 * the top `StatusBar` (1 row) + the `PromptShell` (≈6 rows: top margin,
 * padding, the editor line, the meta-row, and the `╹` cap) + the
 * `HotkeyHint` (1 row). Ink 7 does NOT clip a frame taller than the
 * terminal — it overlaps/garbles earlier lines instead (verified) — so
 * the per-tab budget must subtract this accurately and err generous.
 */
export const APP_CHROME_ROWS = 9;
/**
 * Height consumed INSIDE the debug pane above the active tab: the
 * `SubTabBar` (1 row) + the `DebugDiagnosticsLine`. The diagnostics line
 * is a single long `<Text>` (cwd · llama url · llm/step · kv · tools ·
 * approval · skills) that Ink **wraps to 2 rows** at typical widths
 * (~100 cols) — confirmed by runtime logs where the full panel
 * overflowed by exactly one row at the budget boundary. Count it as 2.
 */
const DEBUG_TAB_CHROME_ROWS = 3;
/**
 * Extra cushion absorbed off the budget. The diagnostics line and the
 * bottom `HotkeyHint` both wrap on narrower terminals, so the exact
 * chrome height is width-dependent; reserving one spare row keeps the
 * windowed panel from overflowing (and garbling the section headers)
 * when a wrap adds a line we did not predict.
 */
const RENDER_SAFETY_ROWS = 1;
/**
 * Fixed chrome of the compact filter-bar manage panels (Tasks / Skills
 * / Memory / MCP): the one-line filter bar plus an optional status /
 * error line, with a small margin.
 */
const COMPACT_PANEL_HEADER_ROWS = 3;
/** Never window below this many rows — keeps a usable slice on tiny terminals. */
const MIN_LIST_ROWS = 3;

/**
 * Total number of rows available for an active tab's own content
 * (panel chrome + its list), derived from the live terminal height.
 */
function tabContentBudget(terminalRows: number): number {
  return Math.max(
    MIN_LIST_ROWS,
    terminalRows - APP_CHROME_ROWS - DEBUG_TAB_CHROME_ROWS - RENDER_SAFETY_ROWS,
  );
}

function ActiveDebugTab({
  state,
  maxVisible,
  onMcpAddJsonChange,
  onMcpAddSubmit,
  onMcpAddCancel,
}: {
  state: TuiState;
  maxVisible: number;
  onMcpAddJsonChange?: (json: string) => void;
  onMcpAddSubmit?: (json: string) => void;
  onMcpAddCancel?: () => void;
}): ReactElement {
  const { rows: terminalRows } = useTerminalSize();
  const tabBudget = tabContentBudget(terminalRows);
  // Compact panels have a tiny fixed header, so they get the list slice
  // directly. LLM / Models own large fixed chrome (RouteCard / status
  // footer) that they collapse themselves, so they receive the full
  // tab budget and split it internally.
  const compactRows = Math.max(
    MIN_LIST_ROWS,
    tabBudget - COMPACT_PANEL_HEADER_ROWS,
  );
  switch (state.activeTab) {
    case "feed":
      return <EventFeed state={state} maxVisible={maxVisible} />;
    case "world":
      return <WorldPanel state={state} />;
    case "reasoning":
      return <ReasoningTab state={state} maxVisible={maxVisible} />;
    case "logs":
      return <LogsTab state={state} maxVisible={maxVisible} />;
    case "tasks":
      return (
        <TasksPanel panel={state.tasksPanel} now={Date.now()} maxRows={compactRows} />
      );
    case "skills":
      return <SkillsPanel panel={state.skillsPanel} maxRows={compactRows} />;
    case "memory":
      return <MemoryPanel panel={state.memoryPanel} maxRows={compactRows} />;
    case "mcp":
      return (
        <McpPanel
          panel={state.mcpPanel}
          maxRows={compactRows}
          onAddJsonChange={onMcpAddJsonChange}
          onAddSubmit={onMcpAddSubmit}
          onAddCancel={onMcpAddCancel}
        />
      );
    case "providers":
      return <ProvidersPanel panel={state.providersPanel} />;
    case "llm":
      return <LlmPanel state={state} maxRows={tabBudget} />;
    case "models":
      return <LocalModelsPanel panel={state.localModelsPanel} maxRows={tabBudget} />;
    case "llm-logs":
      return <LocalLlmLogsPanel logs={state.localLlmLogs} maxLines={maxVisible} />;
    case "telegram":
      return <TelegramPanel panel={state.telegramPanel} />;
    case "import":
      return <ImportPanel panel={state.importPanel} />;
    case "privacy":
      return <PrivacyPanel panel={state.privacyPanel} />;
    default:
      return <EventFeed state={state} maxVisible={maxVisible} />;
  }
}

function suffix(count: number): string {
  if (count === 0) return "";
  return ` (${count})`;
}

/**
 * Compact label for the Telegram tab. Surfaces the channel state so an
 * operator scanning the Manage strip sees `Telegram (down)` without
 * entering the panel.
 */
function telegramTabLabel(state: TuiState): string {
  const channelState = state.telegramPanel.channelState;
  if (channelState === "up") return "Telegram (up)";
  if (channelState === "down") return "Telegram (down)";
  return "Telegram";
}

/**
 * Re-export of the section-aware sub-tab cycler. Kept here so existing
 * callers (`app-key-bindings.ts`) can continue importing from the debug
 * pane module without touching the section-helper directly.
 *
 * @deprecated Prefer `cycleSubTab` from `../section.ts`.
 */
export { cycleSubTab as cycleDebugTab } from "../section.js";

/** Combined inner tab order used by tests and helpers that want the full set. */
export const DEBUG_TAB_ORDER: readonly TuiTab[] = [
  ...OBSERVE_TABS,
  ...MANAGE_TABS,
];

