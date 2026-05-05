import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type { TelegramPairingState } from "../telegram-panel-state.js";

export interface TelegramPairingModalProps {
  pairing: TelegramPairingState;
}

/**
 * Pairing-window modal. Shows the remaining seconds until the
 * channel times out and a short instruction line. The countdown is
 * driven by `tui-telegram-orchestrator.ts`, which dispatches a
 * `telegram_pairing_tick` every second so this component only needs
 * to project `pairing.expiresAt - pairing.nowMs`.
 */
export function TelegramPairingModal({
  pairing,
}: TelegramPairingModalProps): ReactElement {
  const remainingMs = Math.max(0, pairing.expiresAt - pairing.nowMs);
  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.accentSoft} paddingX={1}>
      <Text bold color={theme.colors.accentSoft}>
        pairing window open · {seconds}s left
      </Text>
      <Text color={theme.colors.muted}>
        Open Telegram and DM the bot any text from the account you want to
        register as the owner. The first eligible private message is
        captured; group / channel messages are ignored.
      </Text>
      <Text color={theme.colors.muted}>
        Esc to cancel · automatic close on success or timeout
      </Text>
    </Box>
  );
}
