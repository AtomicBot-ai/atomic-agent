import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { EventFeed } from "../event-feed.js";
import { LogsTab } from "../logs-tab.js";
import { MetricsFooter } from "../metrics-footer.js";
import { ReasoningTab } from "../reasoning-tab.js";
import { WorldPanel } from "../world-panel.js";
import { theme } from "../theme/theme.js";
import type { TuiState, TuiTab } from "../tui-state.js";

interface DebugPaneProps {
  state: TuiState;
  maxVisible: number;
}

/**
 * Debug pane: wraps the existing telemetry views behind a compact tab
 * bar. Rendered in place of the chat log whenever `uiMode === "debug"`
 * so the user can inspect feed/world/reasoning/logs/metrics without
 * leaving the session.
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
    { id: "metrics", label: "Metrics" },
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
    case "metrics":
      return <MetricsFooter state={state} />;
    default:
      return <EventFeed state={state} maxVisible={maxVisible} />;
  }
}

function suffix(count: number): string {
  if (count === 0) return "";
  return ` (${count})`;
}

const DEBUG_TAB_ORDER: readonly TuiTab[] = [
  "feed",
  "world",
  "reasoning",
  "logs",
  "metrics",
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
