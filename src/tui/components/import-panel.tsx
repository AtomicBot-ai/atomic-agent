import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type {
  ImportItemResult,
  ImportItemStatus,
  ImportReport,
} from "../../import/import-report.js";
import { theme } from "../theme/theme.js";
import type {
  ImportFormState,
  ImportPanelState,
  ImportSourceId,
} from "../import/import-panel-state.js";

export interface ImportPanelProps {
  panel: ImportPanelState;
  maxRows?: number;
}

/**
 * Top-level router for the Import tab. Switches between the configure
 * form, the dry-run preview, the running indicator and the final report
 * based on `panel.mode`. Rendering only — every keystroke flows through
 * `import-key-bindings.ts`.
 */
export function ImportPanel(props: ImportPanelProps): ReactElement {
  const { panel, maxRows = 12 } = props;
  const sourceLabel = panel.form.source === "openclaw" ? "OpenClaw" : "Hermes";
  return (
    <Box flexDirection="column">
      <Text bold color={theme.colors.accentSoft}>
        Import · {sourceLabel} {theme.glyphs.arrowRight} atomic-agent
      </Text>
      {panel.notice ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>! {panel.notice}</Text>
        </Box>
      ) : null}
      {panel.mode === "configure" ? <ConfigureForm form={panel.form} /> : null}
      {panel.mode === "running" ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>importing… please wait</Text>
        </Box>
      ) : null}
      {panel.mode === "preview" && panel.report ? (
        <ReportView report={panel.report} executed={false} maxRows={maxRows} />
      ) : null}
      {panel.mode === "done" && panel.report ? (
        <ReportView report={panel.report} executed maxRows={maxRows} />
      ) : null}
    </Box>
  );
}

function ConfigureForm({ form }: { form: ImportFormState }): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
    >
      <SourceRow source={form.source} focused={form.focus === "sourceType"} />
      <TextRow
        label="source"
        value={form.sourceDir}
        placeholder={form.source === "openclaw" ? "~/.openclaw" : "~/.hermes"}
        focused={form.focus === "source"}
      />
      <ToggleRow label="sessions" on={form.sessions} focused={form.focus === "sessions"} />
      <ToggleRow label="cron" on={form.cron} focused={form.focus === "cron"} />
      {form.source === "hermes" ? (
        <ToggleRow
          label="secrets"
          on={form.secrets}
          focused={form.focus === "secrets"}
          hint="OPENROUTER_API_KEY / AIMLAPI_API_KEY"
        />
      ) : null}
      <ToggleRow
        label="overwrite"
        on={form.overwrite}
        focused={form.focus === "overwrite"}
        hint="replace differing destinations"
      />
      <TextRow
        label="limit"
        value={form.limit}
        placeholder="(no limit)"
        focused={form.focus === "limit"}
      />
      <RunRow focused={form.focus === "run"} />
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          ↑↓ move · ←/→ switch source · space toggle · type to edit · Enter on
          Run = preview · Ctrl+Enter preview
        </Text>
      </Box>
    </Box>
  );
}

function SourceRow({
  source,
  focused,
}: {
  source: ImportSourceId;
  focused: boolean;
}): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>{labelPrefix("source-of", focused)}</Text>
      <SourceChoice label="hermes" active={source === "hermes"} />
      <Text color={theme.colors.muted}> / </Text>
      <SourceChoice label="openclaw" active={source === "openclaw"} />
    </Box>
  );
}

function SourceChoice({
  label,
  active,
}: {
  label: string;
  active: boolean;
}): ReactElement {
  return (
    <Text color={active ? theme.colors.success : theme.colors.muted} bold={active}>
      {active ? `‹${label}›` : ` ${label} `}
    </Text>
  );
}

function TextRow({
  label,
  value,
  placeholder,
  focused,
}: {
  label: string;
  value: string;
  placeholder: string;
  focused: boolean;
}): ReactElement {
  const display = value.length > 0 ? value : placeholder;
  const color = value.length > 0 ? theme.colors.accentSoft : theme.colors.muted;
  return (
    <Box>
      <Text color={theme.colors.muted}>{labelPrefix(label, focused)}</Text>
      <Text color={color} italic={value.length === 0}>
        {display}
        {focused ? theme.glyphs.promptCaret : ""}
      </Text>
    </Box>
  );
}

function ToggleRow({
  label,
  on,
  focused,
  hint,
}: {
  label: string;
  on: boolean;
  focused: boolean;
  hint?: string;
}): ReactElement {
  return (
    <Box>
      <Text color={theme.colors.muted}>{labelPrefix(label, focused)}</Text>
      <Text color={on ? theme.colors.success : theme.colors.muted} bold={on}>
        [{on ? theme.glyphs.check : " "}]
      </Text>
      {hint ? <Text color={theme.colors.muted}>{"  "}{hint}</Text> : null}
    </Box>
  );
}

function RunRow({ focused }: { focused: boolean }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={focused ? theme.colors.success : theme.colors.muted} bold={focused}>
        {focused ? theme.glyphs.chevronRight : " "} Run preview
      </Text>
    </Box>
  );
}

function labelPrefix(label: string, focused: boolean): string {
  const marker = focused ? theme.glyphs.chevronRight : " ";
  return `${marker} ${label.padEnd(10)}: `;
}

function ReportView({
  report,
  executed,
  maxRows,
}: {
  report: ImportReport;
  executed: boolean;
  maxRows: number;
}): ReactElement {
  const items = report.items.slice(0, maxRows);
  const hidden = report.items.length - items.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.colors.muted}>
        {executed ? "result" : "preview (dry-run)"} · {report.items.length} item
        {report.items.length === 1 ? "" : "s"}
      </Text>
      {items.map((item, idx) => (
        <ReportRow key={`${item.kind}:${idx}`} item={item} />
      ))}
      {hidden > 0 ? (
        <Text color={theme.colors.muted}>  … {hidden} more</Text>
      ) : null}
      <SummaryRow report={report} />
      <Box marginTop={1}>
        {executed ? (
          <Text color={theme.colors.muted}>Enter / Esc back to form</Text>
        ) : (
          <Text color={theme.colors.muted}>
            y / Enter apply · e edit · Esc cancel
          </Text>
        )}
      </Box>
    </Box>
  );
}

function ReportRow({ item }: { item: ImportItemResult }): ReactElement {
  const arrow =
    item.source && item.destination
      ? `${item.source} ${theme.glyphs.arrowRight} ${item.destination}`
      : item.source ?? item.destination ?? "";
  const reason = item.reason ? ` (${item.reason})` : "";
  return (
    <Text>
      <Text color={statusColor(item.status)}>{item.status.padEnd(8)}</Text>
      <Text color={theme.colors.muted}>
        {" "}
        [{item.kind}] {arrow}
        {reason}
      </Text>
    </Text>
  );
}

function SummaryRow({ report }: { report: ImportReport }): ReactElement {
  const s = report.summary;
  return (
    <Box marginTop={1}>
      <Text color={theme.colors.success}>migrated={s.migrated}</Text>
      <Text color={theme.colors.muted}> · skipped={s.skipped}</Text>
      <Text color={theme.colors.warn}> · conflict={s.conflict}</Text>
      <Text color={theme.colors.error}> · error={s.error}</Text>
    </Box>
  );
}

function statusColor(status: ImportItemStatus): string {
  switch (status) {
    case "migrated":
      return theme.colors.success;
    case "skipped":
      return theme.colors.muted;
    case "conflict":
      return theme.colors.warn;
    case "error":
      return theme.colors.error;
    default:
      return theme.colors.muted;
  }
}
