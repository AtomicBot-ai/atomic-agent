import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { useTerminalSize } from "../../hooks/use-terminal-size.js";
import { theme } from "../../theme/theme.js";
import {
  SWARM_EDIT_FIELDS,
  aliveSwarmCount,
  formStepValue,
  type SwarmAddForm,
  type SwarmEditField,
  type SwarmPanelState,
  type SwarmRow,
} from "../swarm-panel-state.js";
import { STRIP_ROWS } from "../swarm-critters.js";
import { ZerglingStrip } from "../zergling-strip.js";

export interface SwarmPanelProps {
  panel: SwarmPanelState;
  /** Rows the pane can spend on the list (the strip takes its own). */
  maxRows?: number;
  /** Test seam — freeze the hatchery. */
  animate?: boolean;
  /** Test seam — pane width; defaults to the terminal. */
  width?: number;
}

/** The list needs this much room before the hatchery is worth drawing. */
const STRIP_MIN_LIST_ROWS = 6;
/**
 * One row of slack on top of the list + strip. Without it the pane can
 * hand out just enough rows for the strip to be drawn and then have its
 * last row eaten by the footer, cutting the eggs in half.
 */
const STRIP_HEADROOM = 1;
/** Longest failure text a row will show before it is cut. */
const ROW_ERROR_CHARS = 44;

/**
 * The Swarm tab: every bot on this runtime. The two primary channels
 * first (read-only here — Integrations owns them), then every extra
 * unit with its state, owner and role. `a` adds a bot through a short
 * wizard; the hatchery along the bottom grows one critter per bot that
 * is switched on and holds a token.
 */
export function SwarmPanel({
  panel,
  maxRows = 14,
  animate = true,
  width,
}: SwarmPanelProps): ReactElement {
  const size = useTerminalSize();
  const paneWidth = Math.max(0, (width ?? size.columns) - 2);
  const showStrip =
    maxRows >= STRIP_MIN_LIST_ROWS + STRIP_ROWS + STRIP_HEADROOM;
  const listRows = showStrip ? maxRows - STRIP_ROWS - 1 : maxRows;
  return (
    <Box flexDirection="column">
      <Header panel={panel} />
      {panel.lastError ? (
        <Box>
          <Text color={theme.colors.error}>! {panel.lastError}</Text>
        </Box>
      ) : null}
      {panel.message ? (
        <Box>
          <Text color={theme.colors.accentSoft}>{panel.message}</Text>
        </Box>
      ) : null}
      {panel.mode === "add" ? (
        <AddWizard form={panel.form} />
      ) : panel.mode === "edit" ? (
        <EditView panel={panel} />
      ) : (
        <ListView panel={panel} maxRows={listRows} />
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{hint(panel)}</Text>
      </Box>
      {showStrip ? (
        <Box marginTop={1}>
          <ZerglingStrip
            width={paneWidth}
            count={aliveSwarmCount(panel.rows)}
            animate={animate}
          />
        </Box>
      ) : null}
    </Box>
  );
}

function Header({ panel }: { panel: SwarmPanelState }): ReactElement {
  const up = panel.rows.filter((r) => r.state === "up").length;
  return (
    <Box>
      <Text bold color={theme.colors.accentSoft}>
        Swarm
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {panel.rows.length} {panel.rows.length === 1 ? "bot" : "bots"} · {up} up
      </Text>
      {panel.busy ? <Text color={theme.colors.muted}>{"  "}…</Text> : null}
    </Box>
  );
}

function ListView({
  panel,
  maxRows,
}: {
  panel: SwarmPanelState;
  maxRows: number;
}): ReactElement {
  if (panel.rows.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>no bots yet — press a to add one</Text>
      </Box>
    );
  }
  // Keep the cursor on screen when the list outgrows the pane.
  const visible = Math.max(1, maxRows);
  const start = Math.max(
    0,
    Math.min(panel.selected - visible + 1, panel.rows.length - visible),
  );
  const rows = panel.rows.slice(start, start + visible);
  return (
    <Box marginTop={1} flexDirection="column">
      {rows.map((row, i) => {
        const index = start + i;
        const active = index === panel.selected;
        // One line per bot, always: a long failure message used to wrap
        // and shove the role onto a second line, mangling the row.
        const confirming = panel.mode === "remove" && active;
        return (
          <Box key={row.id} height={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color={active ? theme.colors.accent : theme.colors.muted}>
                {active ? "> " : "  "}
              </Text>
              <Text color={theme.colors.muted}>{kindTag(row.kind)} </Text>
              <Text bold={active}>{row.label}</Text>
              {row.botUsername ? (
                <Text color={theme.colors.muted}> @{row.botUsername}</Text>
              ) : null}
              <Text color={stateColor(row)}>
                {"  "}
                {stateText(row)}
              </Text>
              {row.role && !confirming ? (
                <Text color={theme.colors.muted}>
                  {"  · "}
                  {row.role}
                </Text>
              ) : null}
              {confirming ? (
                <Text color={theme.colors.error}>{"  remove? y / esc"}</Text>
              ) : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function AddWizard({ form }: { form: SwarmAddForm }): ReactElement {
  const stepIndex =
    ["kind", "label", "role", "token", "owner"].indexOf(form.step) + 1;
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text bold>Add a bot</Text>
        <Text color={theme.colors.muted}>
          {"  "}step {stepIndex}/5
        </Text>
      </Box>
      {form.step === "kind" ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            {"  "}Where does it live?{"  "}
          </Text>
          <Text
            color={
              form.kind === "telegram"
                ? theme.colors.accent
                : theme.colors.muted
            }
          >
            {form.kind === "telegram" ? "[ Telegram ]" : "  Telegram  "}
          </Text>
          <Text
            color={
              form.kind === "discord" ? theme.colors.accent : theme.colors.muted
            }
          >
            {form.kind === "discord" ? "[ Discord ]" : "  Discord  "}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.colors.muted}>
              {"  "}
              {stepLabel(form)}
              {"  "}
            </Text>
            <Text color={theme.colors.accent}>
              {form.step === "token"
                ? "•".repeat(formStepValue(form).length)
                : formStepValue(form)}
              <Text color={theme.colors.muted}>▏</Text>
            </Text>
          </Box>
          <Box>
            <Text color={theme.colors.muted}>
              {"    "}
              {stepHelp(form)}
            </Text>
          </Box>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          {"  "}
          {kindTag(form.kind)} {form.label || "…"}
          {form.role ? ` · ${form.role}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

function EditView({ panel }: { panel: SwarmPanelState }): ReactElement {
  const row = panel.rows[panel.selected];
  if (!row) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>nothing selected</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.colors.muted}>{kindTag(row.kind)} </Text>
        <Text bold>{row.label}</Text>
        <Text color={stateColor(row)}>
          {"  "}
          {stateText(row)}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {SWARM_EDIT_FIELDS.map((field) => {
          const active = field === panel.editField;
          const typing = active && panel.editBuffer !== null;
          return (
            <Box key={field}>
              <Text color={active ? theme.colors.accent : theme.colors.muted}>
                {active ? "> " : "  "}
              </Text>
              <Text>{fieldLabel(field)}</Text>
              <Text color={theme.colors.muted}>{"  "}</Text>
              {typing ? (
                <Text color={theme.colors.accent}>
                  {field === "token"
                    ? "•".repeat(panel.editBuffer!.length)
                    : panel.editBuffer}
                  <Text color={theme.colors.muted}>▏</Text>
                </Text>
              ) : (
                <Text color={theme.colors.accentSoft}>
                  {fieldValue(row, field)}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function kindTag(kind: SwarmRow["kind"]): string {
  return kind === "telegram" ? "[tg]" : "[dc]";
}

function stateText(row: SwarmRow): string {
  if (row.pairing?.active) {
    return row.pairing.secondsLeft === null
      ? "pairing…"
      : `pairing… ${row.pairing.secondsLeft}s`;
  }
  if (!row.enabled) return "off";
  if (!row.hasToken) return "no token";
  if (row.state === "down") {
    return row.lastError
      ? `down: ${clip(row.lastError, ROW_ERROR_CHARS)}`
      : "down";
  }
  if (row.state === "up" && row.ownerUserId === null) return "up · unpaired";
  return row.state;
}

/** Cut `text` to `max` characters on a code-point boundary. */
function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

function stateColor(row: SwarmRow): string {
  if (row.pairing?.active) return theme.colors.accent;
  if (!row.enabled || !row.hasToken) return theme.colors.muted;
  if (row.state === "down") return theme.colors.error;
  if (row.state === "up") return theme.colors.accentSoft;
  return theme.colors.muted;
}

function stepLabel(form: SwarmAddForm): string {
  switch (form.step) {
    case "label":
      return "Name";
    case "role":
      return "Role";
    case "token":
      return "Bot token";
    case "owner":
      return "Owner id";
    default:
      return "";
  }
}

function stepHelp(form: SwarmAddForm): string {
  switch (form.step) {
    case "label":
      return "how this bot shows up in the list, e.g. Ops";
    case "role":
      return "what it is for — a note for you, optional";
    case "token":
      return form.kind === "telegram"
        ? "from @BotFather; leave empty to add it later"
        : "from the Discord developer portal → Bot → Reset Token; empty = later";
    case "owner":
      return form.kind === "telegram"
        ? "your numeric Telegram id; leave empty and press p afterwards to pair by DM"
        : "your Discord user id (Developer Mode → Copy User ID)";
    default:
      return "";
  }
}

function fieldLabel(field: SwarmEditField): string {
  switch (field) {
    case "label":
      return "Name";
    case "role":
      return "Role";
    case "owner":
      return "Owner id";
    case "token":
      return "Bot token";
  }
}

function fieldValue(row: SwarmRow, field: SwarmEditField): string {
  switch (field) {
    case "label":
      return row.label;
    case "role":
      return row.role || "—";
    case "owner":
      return row.ownerUserId ?? "unpaired";
    case "token":
      return row.hasToken ? "••••••••" : "not set";
  }
}

function hint(panel: SwarmPanelState): string {
  switch (panel.mode) {
    case "add":
      return panel.form.step === "kind"
        ? "←/→ pick · enter next · esc cancel"
        : panel.form.step === "owner"
          ? "enter add the bot · esc back"
          : "type · enter next · esc back";
    case "edit":
      return panel.editBuffer !== null
        ? "enter save · esc cancel"
        : "↑/↓ field · enter type a new value · esc back";
    case "remove":
      return "y remove · esc keep";
    default: {
      const row = panel.rows[panel.selected];
      if (row?.primary)
        return "↑/↓ move · a add · primaries are managed in /integrations";
      return "↑/↓ move · a add · e edit · enter on/off · p pair · s restart · d remove";
    }
  }
}
