import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type {
  TaskCreateFocus,
  TaskCreateFormState,
  TaskCreateKind,
} from "../tasks/tasks-panel-state.js";
import { formatUnixMs } from "../tasks/tasks-summary.js";

export interface TasksCreateFormProps {
  form: TaskCreateFormState;
}

/**
 * Multi-field modal shown when `panel.mode === "create"`. Rendering
 * only — every keystroke flows through the app-key-bindings layer and
 * dispatches `tasks_create_form_updated` / `tasks_create_focus_set`
 * actions. Validation lives in `tasks-form-validator.ts`; this
 * component just mirrors the preview and error messages.
 */
export function TasksCreateForm(props: TasksCreateFormProps): ReactElement {
  const { form } = props;
  const expressionField = expressionFieldForKind(form);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      paddingY={0}
    >
      <Text bold color={theme.colors.accentSoft}>
        new task
      </Text>
      <KindRow kind={form.kind} focused={form.focus === "kind"} />
      <FieldRow
        label={expressionField.label}
        value={expressionField.value}
        placeholder={expressionField.placeholder}
        focused={form.focus === "expression"}
      />
      {form.kind === "cron" ? (
        <FieldRow
          label="tz"
          value={form.tz}
          placeholder="(optional, e.g. Europe/Berlin)"
          focused={form.focus === "tz"}
        />
      ) : null}
      <FieldRow
        label="message"
        value={form.message}
        placeholder="what should the agent do when this fires?"
        focused={form.focus === "message"}
      />
      <PreviewBlock form={form} />
      <SubmitHint form={form} />
    </Box>
  );
}

function KindRow({
  kind,
  focused,
}: {
  kind: TaskCreateKind;
  focused: boolean;
}): ReactElement {
  const kinds: readonly TaskCreateKind[] = ["cron", "interval", "at"];
  return (
    <Box>
      <Text color={theme.colors.muted}>{labelPrefix("kind", focused)}</Text>
      {kinds.map((candidate, idx) => (
        <Text
          key={candidate}
          color={candidate === kind ? theme.colors.accentSoft : theme.colors.muted}
          bold={candidate === kind}
        >
          {idx > 0 ? " / " : ""}
          {candidate}
        </Text>
      ))}
    </Box>
  );
}

interface FieldDescriptor {
  label: string;
  value: string;
  placeholder: string;
}

function expressionFieldForKind(form: TaskCreateFormState): FieldDescriptor {
  if (form.kind === "cron") {
    return {
      label: "cron",
      value: form.cronExpression,
      placeholder: "0 * * * * (standard 5-field cron)",
    };
  }
  if (form.kind === "interval") {
    return {
      label: "every (s)",
      value: form.intervalSeconds,
      placeholder: "300",
    };
  }
  return {
    label: "at",
    value: form.atIsoOrMs,
    placeholder: "2026-05-01T09:00:00Z or Unix-ms",
  };
}

function FieldRow({
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
  const color = value.length > 0
    ? theme.colors.accentSoft
    : theme.colors.muted;
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

function labelPrefix(label: string, focused: boolean): string {
  const marker = focused ? theme.glyphs.chevronRight : " ";
  return `${marker} ${label.padEnd(10)}: `;
}

function PreviewBlock({ form }: { form: TaskCreateFormState }): ReactElement {
  if (form.preview.error) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.error}>error: {form.preview.error}</Text>
      </Box>
    );
  }
  if (form.preview.nextFirings.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>(preview unavailable)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.colors.muted}>next firings:</Text>
      {form.preview.nextFirings.map((ms, idx) => (
        <Text key={`${ms}:${idx}`} color={theme.colors.muted}>
          · {formatUnixMs(ms)}
        </Text>
      ))}
    </Box>
  );
}

function SubmitHint({ form }: { form: TaskCreateFormState }): ReactElement {
  const canSubmit = form.preview.ok && !form.submitting;
  return (
    <Box marginTop={1}>
      <Text
        color={canSubmit ? theme.colors.success : theme.colors.muted}
        bold={form.focus === "submit"}
      >
        Ctrl+Enter submit
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}· Tab next · Shift+Tab back · Esc cancel
        {form.submitting ? " · submitting…" : ""}
      </Text>
    </Box>
  );
}

/** Exposed for tests — pure mapping helper. */
export function focusAfter(
  form: TaskCreateFormState,
  delta: 1 | -1,
  order: readonly TaskCreateFocus[],
): TaskCreateFocus {
  const filtered =
    form.kind === "cron"
      ? order
      : order.filter((step) => step !== "tz");
  const idx = filtered.indexOf(form.focus);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + delta + filtered.length) % filtered.length;
  return filtered[next] ?? "kind";
}
