import { Box, Text } from "ink";
import type { ReactElement } from "react";
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
    <Box>
      {tabs.map((tab, idx) => {
        const active = tab.id === state.activeTab;
        return (
          <Text key={tab.id}>
            <Text
              color={active ? theme.colors.accentSoft : theme.colors.muted}
              bold={active}
            >
              {active ? `${theme.glyphs.chevronRight} ` : "  "}
              {tab.label}
            </Text>
            {idx < tabs.length - 1 ? (
              <Text color={theme.colors.muted}>
                {"  "}
                {theme.glyphs.pipeSeparator}
                {"  "}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
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
  ];
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
      return <TasksPanel panel={state.tasksPanel} now={Date.now()} />;
    case "skills":
      return <SkillsPanel panel={state.skillsPanel} />;
    case "memory":
      return <MemoryPanel panel={state.memoryPanel} />;
    case "mcp":
      return (
        <McpPanel
          panel={state.mcpPanel}
          onAddJsonChange={onMcpAddJsonChange}
          onAddSubmit={onMcpAddSubmit}
          onAddCancel={onMcpAddCancel}
        />
      );
    case "providers":
      return <ProvidersPanel panel={state.providersPanel} />;
    case "llm":
      return <LlmPanel state={state} />;
    case "models":
      return <LocalModelsPanel panel={state.localModelsPanel} />;
    case "llm-logs":
      return <LocalLlmLogsPanel logs={state.localLlmLogs} maxLines={maxVisible} />;
    case "telegram":
      return <TelegramPanel panel={state.telegramPanel} />;
    case "import":
      return <ImportPanel panel={state.importPanel} />;
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
