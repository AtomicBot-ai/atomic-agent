import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * Required-update gate (ATO-1125). The latest release's policy
 * (`src/update/update-policy.ts`) can list the running version:
 *
 * - `below-minimum`: the status-bar banner turns into a warning, and a
 *   chat still starts;
 * - `broken`: the chat start screen shows "Update required" with the
 *   update command, and a NEW chat is refused until the update.
 *
 * Only a new chat is gated. A session that already has turns, a turn
 * that is running, and messages queued behind it are never touched.
 * A missing or unreadable policy never reaches here (no `required`),
 * so the gate fails open.
 */
export type RequiredUpdate = "broken" | "below-minimum" | null | undefined;

/** The command `atomic-agent update --help` documents. */
export const UPDATE_COMMAND = "atomic-agent update";

export const REQUIRED_UPDATE_REFUSAL = `Update required: this version has a known problem and cannot start a new chat. Run \`${UPDATE_COMMAND}\` (message returned to the editor)`;

/** True when this submit would open a new chat a broken version must not start. */
export function blocksNewChat(required: RequiredUpdate, sessionTurns: number): boolean {
  return required === "broken" && sessionTurns === 0;
}

export function UpdateRequiredScreen({ latest }: { latest: string }): ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={2}>
      <Box borderStyle="round" borderColor={theme.colors.warn} paddingX={1} flexDirection="column">
        <Text color={theme.colors.warn} bold>
          {theme.glyphs.warn} Update required
        </Text>
        <Text>This version has a known problem. Update to v{latest} to start a new chat.</Text>
        <Text>
          Run <Text color={theme.colors.accent} bold>{UPDATE_COMMAND}</Text> or press Update in the bar.
        </Text>
        <Text color={theme.colors.muted}>Chats you already have keep working.</Text>
      </Box>
    </Box>
  );
}
