import { Box, Text, useInput } from "ink";
import { useRef, useState, type ReactElement, type ReactNode } from "react";

import type { ShellSecretPrompt } from "../../approval/shell-secret.js";
import { theme } from "../theme/theme.js";
import { applySecretKey, maskSecret } from "./secret-input-keys.js";

/**
 * The TUI's card for a `shell_secret_input` request (ATO-2486), drawn in the
 * approval prompt's place: which job asks for what, and a masked field.
 * The composer stands down while it is up (`tui-app.tsx`), so a key
 * typed here reaches no draft, history or steer. Enter sends, Esc or the
 * deny chord skips (`approvalHotkey`), Ctrl+C stops the turn.
 */
export function SecretInputPrompt({
  prompt,
  onSubmit,
  skipButton,
}: {
  prompt: ShellSecretPrompt;
  /** The typed value; `false` keeps the field open (it is cleared). */
  onSubmit: (value: string) => boolean;
  skipButton: ReactNode;
}): ReactElement {
  const [buffer, setBuffer] = useState("");
  // Keys can land between renders; read the live buffer, not a stale one.
  const live = useRef("");
  useInput((input, key) => {
    const result = applySecretKey(live.current, input, key);
    if (result.kind === "ignore") return;
    if (result.kind === "submit") {
      if (result.buffer.length === 0) return;
      onSubmit(result.buffer);
      live.current = "";
      setBuffer("");
      return;
    }
    live.current = result.buffer;
    setBuffer(result.buffer);
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.colors.accent}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.colors.accent}>
        {`secret input · job ${prompt.jobId} asks for ${prompt.label}`}
      </Text>
      <Text color={theme.colors.muted}>{prompt.commandLine}</Text>
      {prompt.promptLine.length > 0 ? <Text>{prompt.promptLine}</Text> : null}
      <Box marginTop={1} borderStyle="round" borderColor={theme.colors.accent} paddingX={1}>
        <Text color={theme.colors.accent}>{buffer.length > 0 ? maskSecret(buffer) : " "}</Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        {skipButton}
      </Box>
      <Text color={theme.colors.muted}>
        type it here, then enter: it goes straight into the job and the agent never sees it
      </Text>
    </Box>
  );
}
