import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ImportReport } from "../../import/index.js";
import { MouseListRow } from "../mouse/mouse-list-row.js";
import { plainKey } from "../mouse/synthetic-key.js";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import {
  summarizeImportReport,
  type OnboardingImportAgentRow,
  type OnboardingImportOptionRow,
} from "../onboarding/import-step.js";
import { handleOnboardingStepKey } from "../onboarding/onboarding-step-keys.js";
import { ROW_INDENT, rowPrefix } from "../onboarding/onboarding-rows.js";
import { theme } from "../theme/theme.js";

/**
 * The first-run import screens: pick the agents found on this machine,
 * toggle what to bring over, read the dry-run, read the result. All
 * three are pure renders of `OnboardingUiState`; the keys live in
 * `onboarding-step-keys.ts` and the runs in the import orchestrator.
 */

const PICK_EXPLAINER: readonly string[] = [
  "Other agents keep skills, memory, sessions and keys on this machine.",
  "Pick which ones to bring into atomic-agent — nothing is written before",
  "you see a preview, and nothing is ever removed from the source.",
];

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
function pressSpace(): NonNullable<Parameters<typeof MouseListRow>[0]["onActivate"]> {
  return (mouse) => {
    handleOnboardingStepKey(" ", plainKey(), {
      state: mouse.getState(),
      dispatch: mouse.dispatch,
      callbacks: mouse.callbacks,
    });
  };
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
  ]);
}

export function OnboardingImportPickStep(props: {
  agents: readonly OnboardingImportAgentRow[];
  cursor: number;
}): ReactElement {
  const count = Math.max(1, props.agents.length);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="column" marginBottom={1}>
        {PICK_EXPLAINER.map((line) => (
          <Text key={line} color={theme.colors.muted}>
            {line}
          </Text>
        ))}
      </Box>
      {props.agents.map((row, index) => (
        <ToggleRow
          key={row.id}
          selected={props.cursor % count === index}
          enabled={row.enabled}
          index={index}
          label={row.label}
          detail={row.dir}
          onToggle={pressSpace()}
        />
      ))}
    </Box>
  );
}

export function measureOnboardingImportOptionsStep(
  options: readonly OnboardingImportOptionRow[],
): number {
  return widestLine(
    options.flatMap((row) => [
      `${ROW_INDENT}${CHECKBOX_ON}${row.agentLabel} · ${row.label}`,
      `${ROW_INDENT}    ${row.description}`,
    ]),
  );
}

export function OnboardingImportOptionsStep(props: {
  options: readonly OnboardingImportOptionRow[];
  cursor: number;
  busy: boolean;
  error: string | null;
}): ReactElement {
  const count = Math.max(1, props.options.length);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.options.map((row, index) => (
        <ToggleRow
          key={`${row.agent}:${row.option}`}
          selected={props.cursor % count === index}
          enabled={row.enabled}
          index={index}
          label={`${row.agentLabel} · ${row.label}`}
          detail={row.description}
          onToggle={pressSpace()}
        />
      ))}
      {props.busy ? (
        <Text color={theme.colors.muted}>scanning the sources…</Text>
      ) : null}
      {props.error !== null ? (
        <Text color={theme.colors.error}>{props.error}</Text>
      ) : null}
    </Box>
  );
}

export function measureOnboardingImportReportStep(
  report: ImportReport | null,
  executed: boolean,
): number {
  return widestLine([
    reportHeadline(report, executed),
    ...(report ? summarizeImportReport(report) : []),
  ]);
}

function reportHeadline(report: ImportReport | null, executed: boolean): string {
  if (!report) return "";
  const s = report.summary;
  if (executed) {
    return s.error > 0
      ? `${theme.glyphs.warn}  Imported with ${s.error} failure${s.error === 1 ? "" : "s"}`
      : `${theme.glyphs.check}  Imported`;
  }
  const actionable = s.migrated + s.conflict;
  return actionable > 0
    ? "Here is what an import would do:"
    : "Nothing new to import — everything is already here or empty.";
}

/**
 * The preview and the result are the same surface — a headline and one
 * line per domain — differing only in tense and in what Enter means,
 * which the footer says.
 */
export function OnboardingImportReportStep(props: {
  report: ImportReport | null;
  executed: boolean;
  busy: boolean;
  error: string | null;
}): ReactElement {
  const headline = reportHeadline(props.report, props.executed);
  const success = props.executed && (props.report?.summary.error ?? 0) === 0;
  return (
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
  );
}
