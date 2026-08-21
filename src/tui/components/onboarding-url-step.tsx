import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { MultiLineEditor } from "./multi-line-editor.js";

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
        {embedding
          ? "Base URL of your embedding llama-server "
          : "Base URL of your chat llama-server "}
        <Text color={theme.colors.muted}>(must answer GET /health)</Text>
      </Text>
      {embedding ? (
        <Text color={theme.colors.muted}>
          Optional — leave it empty to continue without hybrid embedding recall.
        </Text>
      ) : null}
      <Box marginTop={1}>
        <MultiLineEditor
          value={props.value}
          focus={!props.busy}
          disabled={props.busy}
          placeholder={embedding ? "http://127.0.0.1:19092" : "http://127.0.0.1:8080"}
          onChange={props.onChange}
          onSubmit={props.onSubmit}
          onEscape={props.onBack}
        />
      </Box>
      {props.busy ? (
        <Text color={theme.colors.muted}>probing /health…</Text>
      ) : null}
      {props.error ? <Text color={theme.colors.error}>{props.error}</Text> : null}
    </Box>
  );
}
