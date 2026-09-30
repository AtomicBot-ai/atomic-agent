import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ImportReport } from "../../import/index.js";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { MOUSE_LAYER_PANEL } from "../mouse/mouse-registry.js";
import { plainKey, returnKey } from "../mouse/synthetic-key.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import {
  buildImportPickRows,
  importActionLabel,
  IMPORT_SKIP_LABEL,
  summarizeImportReport,
  type OnboardingImportAgentRow,
} from "../onboarding/import-step.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import { theme } from "../theme/theme.js";

/**
 * The first-run import screens: tick the agents found on this machine
 * (or take the skip row), then read what came over. Two screens, not
 * three — the ticks are the confirmation, so the run starts on Enter
 * instead of going through a dry-run nobody could act on differently.
 * All pure renders of `OnboardingUiState`; the keys live in
 * `onboarding-step-keys.ts` and the runs in the import orchestrator.
 */

const PICK_EXPLAINER: readonly string[] = [
  "Other agents keep skills, memory, sessions and keys on this machine.",
  "Tick which ones to bring into atomic-agent — nothing is ever removed",
  "from the source, and anything already here is kept as it is.",
];

const SKIP_DETAIL = "Go straight to your agent — /import works any time later.";

const CHECKBOX_ON = "[x] ";
const CHECKBOX_OFF = "[ ] ";

/** A toggled list row: checkbox, label, detail; click toggles like space. */
function ToggleRow(props: {
  selected: boolean;
  enabled: boolean;
  index: number;
  label: string;
  detail: string;
  /** The action a click's second press sends (space, via the key table). */
  onToggle: Parameters<typeof MouseListRow>[0]["onActivate"];
}): ReactElement {
  return (
    <MouseListRow
      selected={props.selected}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "onboarding_cursor_set", cursor: props.index })
      }
      onActivate={props.onToggle}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text
          color={props.selected ? theme.colors.accent : undefined}
          bold={props.selected}
        >
          {`${rowPrefix(props.selected)}${props.enabled ? CHECKBOX_ON : CHECKBOX_OFF}${props.label}`}
        </Text>
        <Text color={theme.colors.muted}>
          {`${ROW_INDENT}    ${props.detail}`}
        </Text>
      </Box>
    </MouseListRow>
  );
}

/**
 * Sends the same space-toggle the keyboard does, through the key table —
 * the checkbox analogue of `pressEnter`, so a click on the selected row
 * flips it exactly like the spacebar would.
 */
function pressSpace(): NonNullable<
  Parameters<typeof MouseListRow>[0]["onActivate"]
> {
  return (mouse) => {
    handleOnboardingStepKey(" ", plainKey(), {
      state: mouse.getState(),
      dispatch: mouse.dispatch,
      callbacks: mouse.callbacks,
    });
  };
}

/** The action rows' click: the Enter the key table already routes. */
function pressReturn(): NonNullable<
  Parameters<typeof MouseListRow>[0]["onActivate"]
> {
  return (mouse) => {
    handleOnboardingStepKey("", returnKey(), {
      state: mouse.getState(),
      dispatch: mouse.dispatch,
      callbacks: mouse.callbacks,
    });
  };
}

/** A plain action row: label, optional detail, Enter on click. */
function ActionRow(props: {
  selected: boolean;
  index: number;
  label: string;
  detail: string | null;
  bold?: boolean;
}): ReactElement {
  return (
    <MouseListRow
      selected={props.selected}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "onboarding_cursor_set", cursor: props.index })
      }
      onActivate={pressReturn()}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text
          color={props.selected ? theme.colors.accent : undefined}
          bold={props.selected || props.bold}
        >
          {`${rowPrefix(props.selected)}${props.label}`}
        </Text>
        {props.detail !== null ? (
          <Text
            color={theme.colors.muted}
          >{`${ROW_INDENT}${props.detail}`}</Text>
        ) : null}
      </Box>
    </MouseListRow>
  );
}

export function measureOnboardingImportPickStep(
  agents: readonly OnboardingImportAgentRow[],
): number {
  return widestLine([
    ...PICK_EXPLAINER,
    ...agents.flatMap((row) => [
      `${ROW_INDENT}${CHECKBOX_ON}${row.label}`,
      `${ROW_INDENT}    ${row.dir}`,
    ]),
    `${ROW_INDENT}${IMPORT_SKIP_LABEL}`,
    `${ROW_INDENT}${SKIP_DETAIL}`,
    `${ROW_INDENT}${importActionLabel(agents.length)}`,
  ]);
}

export function OnboardingImportPickStep(props: {
  agents: readonly OnboardingImportAgentRow[];
  cursor: number;
  busy: boolean;
  error: string | null;
}): ReactElement {
  const rows = buildImportPickRows(props.agents);
  const selected = props.cursor % rows.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="column" marginBottom={1}>
        {PICK_EXPLAINER.map((line) => (
          <Text key={line} color={theme.colors.muted}>
            {line}
          </Text>
        ))}
      </Box>
      {rows.map((row, index) =>
        row.kind === "agent" ? (
          <ToggleRow
            key={row.agent.id}
            selected={selected === index}
            enabled={row.agent.enabled}
            index={index}
            label={row.agent.label}
            detail={row.agent.dir}
            onToggle={pressSpace()}
          />
        ) : (
          <ActionRow
            key={row.kind}
            selected={selected === index}
            index={index}
            label={
              row.kind === "skip"
                ? IMPORT_SKIP_LABEL
                : importActionLabel(row.picked)
            }
            detail={row.kind === "skip" ? SKIP_DETAIL : null}
            bold={row.kind === "import"}
          />
        ),
      )}
      {props.busy ? <Text color={theme.colors.muted}>importing…</Text> : null}
      {props.error !== null ? (
        <Text color={theme.colors.error}>{props.error}</Text>
      ) : null}
    </Box>
  );
}

export function measureOnboardingImportReportStep(
  report: ImportReport | null,
): number {
  return widestLine([
    reportHeadline(report),
    ...(report ? summarizeImportReport(report) : []),
  ]);
}

function reportHeadline(report: ImportReport | null): string {
  if (!report) return "";
  const s = report.summary;
  if (s.error > 0) {
    return `${theme.glyphs.warn}  Imported with ${s.error} failure${s.error === 1 ? "" : "s"}`;
  }
  // A run where every row was already here is not a failure and not an
  // import — say so rather than claim a success that moved nothing.
  if (s.migrated === 0) return "Nothing new to import — it was already here.";
  return `${theme.glyphs.check}  Imported`;
}

/**
 * What the import did: a headline and one line per domain. The last
 * screen of the whole first run, so any key — or a click anywhere on
 * the block — hands over to the agent, which is what the footer says.
 */
export function OnboardingImportReportStep(props: {
  report: ImportReport | null;
  busy: boolean;
  error: string | null;
}): ReactElement {
  const mouse = useMouseCommands();
  const headline = reportHeadline(props.report);
  const success = (props.report?.summary.error ?? 0) === 0;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_PANEL}
      onMouse={(hit) => {
        if (!mouse || !isPrimaryPress(hit.event)) return false;
        // "Any key" includes the mouse: the click goes through the same
        // key table, so whatever a keypress does here a click does too.
        handleOnboardingStepKey("", plainKey(), {
          state: mouse.getState(),
          dispatch: mouse.dispatch,
          callbacks: mouse.callbacks,
        });
        return true;
      }}
    >
      <Box flexDirection="column" flexShrink={0}>
        {headline.length > 0 ? (
          <Text color={success ? theme.colors.success : undefined}>
            {headline}
          </Text>
        ) : null}
        {props.report ? (
          <Box flexDirection="column" marginTop={1}>
            {summarizeImportReport(props.report).map((line) => (
              <Text key={line} color={theme.colors.muted}>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {props.busy ? (
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>importing…</Text>
          </Box>
        ) : null}
        {props.error !== null ? (
          <Box marginTop={1}>
            <Text color={theme.colors.error}>{props.error}</Text>
          </Box>
        ) : null}
      </Box>
    </MouseTarget>
  );
}
