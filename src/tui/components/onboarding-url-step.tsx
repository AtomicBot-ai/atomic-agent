import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { widestLine } from "../onboarding/centre-onboarding-block.js";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

const HEALTH_NOTE = "(must answer GET /health)";
const TITLES = {
  chat: "Base URL of your chat llama-server ",
  embedding: "Base URL of your embedding llama-server ",
} as const;
const EMBEDDING_NOTE =
  "Optional — leave it empty to continue without hybrid embedding recall.";
const PLACEHOLDERS = {
  chat: "http://127.0.0.1:8080",
  embedding: "http://127.0.0.1:19092",
} as const;
const PROBING = "probing /health…";
/** The editor's rounded border plus its one column of padding, both sides. */
const EDITOR_CHROME_COLUMNS = 4;

/**
 * Widest line this step draws, for the block that centres it.
 *
 * The editor is measured at its placeholder, not at what has been
 * typed: the box grows with the buffer, and centring on that would slide
 * the whole screen left one column per character. The error line is left
 * out for the same reason the download screen leaves its own out — it
 * carries arbitrary text and wraps inside the block instead.
 */
export function measureOnboardingUrlStep(kind: "chat" | "embedding"): number {
  return widestLine([
    `${TITLES[kind]}${HEALTH_NOTE}`,
    ...(kind === "embedding" ? [EMBEDDING_NOTE] : []),
    `${PLACEHOLDERS[kind]}${" ".repeat(EDITOR_CHROME_COLUMNS)}`,
    PROBING,
  ]);
}

/**
 * The custom-endpoint branch: a llama-server the operator already runs.
 * Two screens — the chat server, then an optional embedding server —
 * each probing `GET /health` before it is written, so a typo is caught
 * here instead of surfacing as a dead agent on the first message.
 */
export function OnboardingUrlStep(props: {
  kind: "chat" | "embedding";
  value: string;
  busy: boolean;
  error: string | null;
  onChange(value: string): void;
  onSubmit(value: string): void;
  onBack(): void;
}): ReactElement {
  const embedding = props.kind === "embedding";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>
        {TITLES[props.kind]}
        <Text color={theme.colors.muted}>{HEALTH_NOTE}</Text>
      </Text>
      {embedding ? <Text color={theme.colors.muted}>{EMBEDDING_NOTE}</Text> : null}
      <Box marginTop={1}>
        <MultiLineEditor
          value={props.value}
          focus={!props.busy}
          disabled={props.busy}
          placeholder={PLACEHOLDERS[props.kind]}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onEscape={props.onBack}
        />
      </Box>
      {props.busy ? <Text color={theme.colors.muted}>{PROBING}</Text> : null}
      {props.error ? <Text color={theme.colors.error}>{props.error}</Text> : null}
    </Box>
  );
}
