import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  findMcpCatalogEntry,
  listMcpCatalog,
  mcpCatalogShelves,
} from "../../mcp/mcp-catalog.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { theme } from "../theme/theme.js";
import { handleMcpTabKey } from "./mcp-key-bindings.js";
import type { McpCatalogPickerState } from "./mcp-panel-state.js";

/** Rows of catalog entries shown at once; the window follows the cursor. */
const WINDOW = 10;

/**
 * ATO-1131: first step of the add modal. The built-in catalog grouped
 * by shelf; the selected entry's details sit under the list. Picking
 * fills the editor with the entry's JSON (see the reducer), so the
 * write still goes through the normal paste path.
 */
export function McpCatalogPicker({
  picker,
}: {
  picker: McpCatalogPickerState;
}): ReactElement {
  const entries = listMcpCatalog();
  const shelfLabel = new Map(mcpCatalogShelves().map((s) => [s.id, s.label]));
  const total = entries.length;
  const start = Math.max(
    0,
    Math.min(total - WINDOW, picker.cursor - Math.floor(WINDOW / 2)),
  );
  const slice = entries.slice(start, start + WINDOW);
  const selected = entries[picker.cursor];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
      marginY={1}
      width="100%"
    >
      <Text bold color={theme.colors.accent}>
        + add MCP server · pick from the catalog
      </Text>
      <Box marginTop={1} flexDirection="column" width="100%">
        {slice.map((entry, idx) => {
          const at = start + idx;
          const prev = entries[at - 1];
          const heading =
            prev === undefined || prev.shelf !== entry.shelf
              ? (shelfLabel.get(entry.shelf) ?? entry.shelf)
              : null;
          const active = at === picker.cursor;
          return (
            <Box key={entry.id} flexDirection="column" width="100%">
              {heading ? (
                <Text color={theme.colors.muted} bold>
                  {heading}
                </Text>
              ) : null}
              <MouseListRow
                selected={active}
                layer={MOUSE_LAYER_MODAL}
                onSelect={(mouse) =>
                  mouse.dispatch({
                    type: "mcp_add_catalog_moved",
                    delta: at - picker.cursor,
                  })
                }
                onActivate={pressEnter(handleMcpTabKey)}
              >
                <Text
                  color={active ? theme.colors.accent : undefined}
                  wrap="truncate-end"
                >
                  {active ? "> " : "  "}
                  {entry.title.padEnd(20)} {entry.description}
                </Text>
              </MouseListRow>
            </Box>
          );
        })}
      </Box>
      {selected ? <SelectedEntry id={selected.id} /> : null}
      <Box marginTop={1} width="100%">
        <Text color={theme.colors.muted}>
          j/k move · Enter pick · p paste your own config · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}

function SelectedEntry({ id }: { id: string }): ReactElement | null {
  const entry = findMcpCatalogEntry(id);
  if (!entry) return null;
  const transport =
    entry.server.command !== undefined
      ? `runs ${entry.server.command} on this computer`
      : `remote: ${entry.server.url ?? ""}`;
  const keys = entry.inputs.filter((i) => i.secret).map((i) => i.label);
  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      <Text color={theme.colors.muted}>
        {transport}
        {entry.requires ? ` · needs ${entry.requires}` : ""}
        {keys.length > 0 ? ` · needs ${keys.join(", ")}` : " · no key needed"}
      </Text>
      {entry.note ? <Text color={theme.colors.muted}>{entry.note}</Text> : null}
      <Text color={theme.colors.muted}>{entry.homepage}</Text>
    </Box>
  );
}

/**
 * Under the editor after a pick: which `<your ...>` values to replace
 * and where each key comes from.
 */
export function McpCatalogHints({ id }: { id: string }): ReactElement | null {
  const entry = findMcpCatalogEntry(id);
  if (!entry || entry.inputs.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column" width="100%">
      <Text color={theme.colors.muted}>
        Replace in the config below before Enter:
      </Text>
      {entry.inputs.map((input) => (
        <Text key={input.placeholder} color={theme.colors.muted}>
          {"  "}
          {input.placeholder}: {input.label}
          {input.getUrl ? ` (get it at ${input.getUrl})` : ""}
        </Text>
      ))}
    </Box>
  );
}
