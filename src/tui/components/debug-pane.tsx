import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { EventFeed } from "../event-feed.js";
import { LogsTab } from "../logs-tab.js";
import { ReasoningTab } from "../reasoning-tab.js";
import { WorldPanel } from "../world-panel.js";
import { theme } from "../theme/theme.js";
import type { TuiState, TuiTab } from "../tui-state.js";
import { LocalLlmLogsPanel } from "./local-llm-logs-panel.js";
import { LocalModelsPanel } from "./local-models-panel.js";
import { TasksPanel } from "./tasks-panel.js";
import { SkillsPanel } from "./skills-panel.js";
import { TelegramPanel } from "../telegram/components/telegram-panel.js";

interface DebugPaneProps {
  state: TuiState;
  maxVisible: number;
}

/**
 * Debug pane: wraps the existing logs / metrics / trace views behind a compact tab
 * bar. Rendered in place of the chat log whenever `uiMode === "debug"`
 * so the user can inspect feed/world/reasoning/logs/tasks without
 * leaving the session. Rolling metrics are always visible in the
 * `FooterLine` below the chat, so they do not need a dedicated tab.
 */
export function DebugPane({ state, maxVisible }: DebugPaneProps): ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <DebugTabBar state={state} />
      <ActiveDebugTab state={state} maxVisible={maxVisible} />
    </Box>
  );
}

function DebugTabBar({ state }: { state: TuiState }): ReactElement {
  const tabs: Array<{ id: TuiTab; label: string }> = [
    { id: "feed", label: `Feed${suffix(state.feed.length)}` },
    { id: "world", label: "World" },
    {
      id: "reasoning",
      label: `Reasoning${suffix(state.reasoning.length)}`,
    },
    { id: "logs", label: `Logs${suffix(state.logs.length)}` },
    { id: "tasks", label: `Tasks${suffix(state.tasksPanel.rows.length)}` },
    { id: "skills", label: `Skills${suffix(state.skillsPanel.rows.length)}` },
    { id: "models", label: "Local LLM" },
    { id: "llm-logs", label: "LLM logs" },
    { id: "telegram", label: telegramTabLabel(state) },
  ];
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

function ActiveDebugTab({
  state,
  maxVisible,
}: {
  state: TuiState;
  maxVisible: number;
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
    case "models":
      return <LocalModelsPanel panel={state.localModelsPanel} />;
    case "llm-logs":
      return <LocalLlmLogsPanel logs={state.localLlmLogs} maxLines={maxVisible} />;
    case "telegram":
      return <TelegramPanel panel={state.telegramPanel} />;
    default:
      return <EventFeed state={state} maxVisible={maxVisible} />;
  }
}

function suffix(count: number): string {
  if (count === 0) return "";
  return ` (${count})`;
}

/**
 * Label shown in the debug tab bar for the Telegram tab. Communicates
 * the current channel state at a glance so operators on other tabs
 * still see "Telegram down" without entering the panel.
 */
function telegramTabLabel(state: TuiState): string {
  const channelState = state.telegramPanel.channelState;
  if (channelState === "up") return "Telegram (up)";
  if (channelState === "down") return "Telegram (down)";
  return "Telegram";
}

const DEBUG_TAB_ORDER: readonly TuiTab[] = [
  "feed",
  "world",
  "reasoning",
  "logs",
  "tasks",
  "skills",
  "models",
  "llm-logs",
  "telegram",
];

/**
 * Cycle through debug tabs in order. Pulled out of the hotkey module so
 * the app shell can advance tabs when Tab is pressed in debug mode.
 */
export function cycleDebugTab(current: TuiTab, direction: 1 | -1 = 1): TuiTab {
  const currentIndex = DEBUG_TAB_ORDER.indexOf(current);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex =
    (safeIndex + direction + DEBUG_TAB_ORDER.length) % DEBUG_TAB_ORDER.length;
  return DEBUG_TAB_ORDER[nextIndex] ?? "feed";
}
