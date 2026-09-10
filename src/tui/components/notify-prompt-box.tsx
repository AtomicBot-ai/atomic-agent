import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LocalModelsNotifyChoice, LocalModelsNotifyPrompt, LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

/** `t Telegram · d Discord · e E-mail · n no · Esc not now`, the remembered pick marked. */
export function notifyPromptHint(current: LocalModelsNotifyChoice | null): string {
  const mark = (choice: LocalModelsNotifyChoice, text: string): string =>
    current === choice ? `${text} ✓` : text;
  return `${mark("telegram", "t Telegram")} · ${mark("discord", "d Discord")} · ${mark("email", "e E-mail")} · ${mark("off", "n no")} · Esc not now`;
}

/**
 * "Tell you when it lands?" — the modal pushed the moment a pull starts.
 * Shows the download it is asking about *moving*: on the LLM tab the
 * modal replaces the panel, and a box that says "the download keeps
 * going" over a hidden progress bar would be asking to be believed.
 */
export function NotifyPromptBox({
  prompt,
  pull,
}: {
  prompt: LocalModelsNotifyPrompt;
  /** The pull in flight, when there is one to report on. */
  pull: LocalModelsPullState | null;
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accent}
      paddingX={1}
      marginBottom={1}
      width="100%"
    >
      <Text bold color={theme.colors.accentSoft}>
        ✦ Tell you when {prompt.label} lands?
      </Text>
      <Text color={theme.colors.muted}>
        A message from the worker when the download finishes — even with the app closed.
        Remembered for the next ones; N changes it.
      </Text>
      {pull ? (
        <Text color={theme.colors.muted}>
          {"⇣ "}
          {pull.percent}% · the download keeps going meanwhile
        </Text>
      ) : null}
      <Text>{notifyPromptHint(prompt.current)}</Text>
    </Box>
  );
}
