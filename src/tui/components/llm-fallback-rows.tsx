import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  selectFallbackPaneRows,
  type FallbackPaneRow,
} from "../llm-panel/fallback/fallback-rows.js";
import type { FallbackLinkRow } from "../llm-panel/fallback/fallback-panel-state.js";
import { handleLlmPanelKey } from "../llm-panel/llm-panel-key-bindings.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

/**
 * The Fallback pane: the ordered cross-provider fallover chain, plus its
 * live-status line and add-link picker. Renders purely from
 * `state.fallbackPanel` (mirrored from config by `FallbackOrchestrator`)
 * and `llmPanel.fallbackCursor`. The chain shown is the *effective* order
 * — the active text provider is always the head, and the auto-appended
 * local last resort is flagged.
 *
 * Rows are `selectFallbackPaneRows` verbatim — including the `+ add
 * link` row on an EMPTY chain, where the cursor's row model would
 * otherwise point at something the screen never drew.
 */
export function FallbackRows({ state }: { state: TuiState }): ReactElement {
  const panel = state.fallbackPanel;
  const rows = selectFallbackPaneRows(state);
  const cursor = state.llmPanel.fallbackCursor;

  if (panel.addPicker) {
    return <AddLinkPicker state={state} />;
  }

  return (
    <Box flexDirection="column">
      <StatusLine state={state} />
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.colors.accentSoft}>
          Fallback chain
        </Text>
        {panel.links.length === 0 ? (
          <Text color={theme.colors.muted}>
            {"  "}No chain configured. Falls back to the active provider only.
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <FallbackRow
            key={rowKey(row)}
            row={row}
            index={index}
            selected={index === cursor}
          />
        ))}
      </Box>
      <Box flexDirection="column">
        <Text color={theme.colors.muted}>
          append local as last resort:{" "}
          <Text bold color={panel.appendLocal ? theme.colors.success : theme.colors.muted}>
            {panel.appendLocal ? "on" : "off"}
          </Text>
          <Text color={theme.colors.muted}> · l to toggle</Text>
        </Text>
        <Text color={theme.colors.muted}>
          {"< >"} move priority · a add link · d remove · l toggle local
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The one live signal the pane has. The runtime breaker instance is not
 * reachable from the TUI, so this shows the last announced switch (from a
 * `provider_switched` event), never an invented cooldown countdown. With
 * no switch yet, the head link is simply "active".
 */
function StatusLine({ state }: { state: TuiState }): ReactElement {
  const { lastSwitch, statusLine } = state.fallbackPanel;
  if (statusLine) {
    return (
      <Box marginBottom={1}>
        <Text color={theme.colors.error}>{statusLine}</Text>
      </Box>
    );
  }
  if (!lastSwitch) {
    return (
      <Box marginBottom={1}>
        <Text color={theme.colors.muted}>
          status: on primary (no fallover this session)
        </Text>
      </Box>
    );
  }
  const line =
    lastSwitch.direction === "away"
      ? `status: failed over ${lastSwitch.from} -> ${lastSwitch.to} (${lastSwitch.reason})`
      : `status: recovered primary ${lastSwitch.to}`;
  return (
    <Box marginBottom={1}>
      <Text
        color={
          lastSwitch.direction === "away"
            ? theme.colors.warn
            : theme.colors.success
        }
      >
        {line}
      </Text>
    </Box>
  );
}

/**
 * One pane row. `MouseListRow` gives it the TUI-wide click contract —
 * first click moves the cursor here, a second click on the selected row
 * replays Enter through `handleLlmPanelKey`, so the mouse runs the exact
 * key path (open the add picker) and can never drift from the keyboard.
 */
function FallbackRow({
  row,
  index,
  selected,
}: {
  row: FallbackPaneRow;
  index: number;
  selected: boolean;
}): ReactElement {
  return (
    <MouseListRow
      selected={selected}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "llm_cursor_set", cursor: index })
      }
      onActivate={pressEnter(handleLlmPanelKey)}
    >
      {row.kind === "add" ? (
        <Text
          color={selected ? theme.colors.accentSoft : theme.colors.muted}
          bold={selected}
          wrap="truncate-end"
        >
          {selected ? ">" : " "} + add link{" "}
          <Text color={theme.colors.muted}>· Enter or a to choose a provider</Text>
        </Text>
      ) : (
        <Text
          color={selected ? theme.colors.accentSoft : undefined}
          bold={selected}
          wrap="truncate-end"
        >
          {selected ? ">" : " "} {formatLink(row.link, row.index)}
          <Text color={theme.colors.muted}> · {linkNote(row.link)}</Text>
        </Text>
      )}
    </MouseListRow>
  );
}

function formatLink(link: FallbackLinkRow, index: number): string {
  const model = link.modelLabel ? `/${link.modelLabel}` : "";
  return `${index + 1}. ${link.providerId}${model} [${link.kind}]`;
}

function linkNote(link: FallbackLinkRow): string {
  if (link.isActive) return "active (primary)";
  if (link.isAppendedLocal) return "local last resort (appendLocal)";
  return "fallover link";
}

function AddLinkPicker({ state }: { state: TuiState }): ReactElement {
  const { addableProviderIds, addPicker } = state.fallbackPanel;
  const cursor = addPicker?.cursor ?? 0;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.colors.accentSoft}>
        Add fallback link
      </Text>
      {addableProviderIds.length === 0 ? (
        <Text color={theme.colors.muted}>
          {"  "}Every configured provider is already in the chain.
        </Text>
      ) : (
        addableProviderIds.map((id, index) => (
          <MouseListRow
            key={id}
            selected={index === cursor}
            onSelect={(mouse) =>
              mouse.dispatch({
                type: "fallback_add_picker_cursor_set",
                cursor: index,
              })
            }
            onActivate={pressEnter(handleLlmPanelKey)}
          >
            <Text
              color={index === cursor ? theme.colors.accentSoft : undefined}
              bold={index === cursor}
              wrap="truncate-end"
            >
              {index === cursor ? ">" : " "} {id}
            </Text>
          </MouseListRow>
        ))
      )}
      <Text color={theme.colors.muted}>{"  "}↑/↓ move · Enter add · Esc cancel</Text>
    </Box>
  );
}

function rowKey(row: FallbackPaneRow): string {
  return row.kind === "add" ? "__add__" : `link:${row.link.providerId}`;
}
