import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type { TelegramTokenPromptState } from "../telegram-panel-state.js";

export interface TelegramTokenPromptProps {
  prompt: TelegramTokenPromptState;
}

/**
 * Masked token entry. Renders a fixed-width row of `•` characters,
 * one per character actually buffered, so the operator gets visual
 * feedback on length without leaking the secret. The actual buffer
 * lives in `state.telegramPanel.tokenPrompt.buffer`; this component
 * never reads it.
 */
export function TelegramTokenPrompt({
  prompt,
}: TelegramTokenPromptProps): ReactElement {
  const masked = "•".repeat(Math.min(prompt.buffer.length, 48));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.accentSoft} paddingX={1}>
      <Text bold color={theme.colors.accentSoft}>
        bot token
      </Text>
      <Text color={theme.colors.muted}>
        Paste the token issued by @BotFather. Saved to{" "}
        <Text color={theme.colors.accentSoft}>{".env"}</Text> at mode 0600.
      </Text>
      <Box>
        <Text color={theme.colors.muted}>{"> "}</Text>
        <Text color={theme.colors.accentSoft}>{masked}</Text>
        <Text color={theme.colors.muted}>
          {prompt.buffer.length > 48 ? `+${prompt.buffer.length - 48}` : ""}
        </Text>
      </Box>
      {prompt.error ? (
        <Text color={theme.colors.error}>! {prompt.error}</Text>
      ) : null}
      <Text color={theme.colors.muted}>
        Enter to save · Esc to cancel · Backspace to edit
        {prompt.submitting ? " · saving…" : ""}
      </Text>
    </Box>
  );
}
