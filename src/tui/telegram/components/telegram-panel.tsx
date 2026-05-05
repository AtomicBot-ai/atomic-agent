import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import { deriveSetupState, type SetupView } from "../setup-state.js";
import type { TelegramPanelState } from "../telegram-panel-state.js";
import { TelegramTokenPrompt } from "./telegram-token-prompt.js";
import { TelegramPairingModal } from "./telegram-pairing-modal.js";

export interface TelegramPanelProps {
  panel: TelegramPanelState;
}

/**
 * The Telegram tab is built around the setup flow first; advanced
 * controls (toggle / restart / clear / refresh) are hidden behind a
 * single-key toggle so the first-run experience feels like a guided
 * setup, not a pile of hotkeys.
 */
export function TelegramPanel({ panel }: TelegramPanelProps): ReactElement {
  const view = deriveSetupState(panel);
  return (
    <Box flexDirection="column">
      {panel.mode === "tokenPrompt" && panel.tokenPrompt ? (
        <TelegramTokenPrompt prompt={panel.tokenPrompt} />
      ) : null}
      {panel.mode === "pairingActive" && panel.pairing ? (
        <TelegramPairingModal pairing={panel.pairing} />
      ) : null}
      {panel.mode === "pairingResult" && panel.pairingResult ? (
        <PairingSuccessCard
          userId={panel.pairingResult.userId}
          welcomeDelivered={panel.pairingResult.welcomeDelivered}
        />
      ) : null}
      {panel.mode === "list" ? <SetupCard view={view} panel={panel} /> : null}
      {panel.showAdvanced ? <AdvancedControls panel={panel} /> : null}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          {panel.showAdvanced ? "a — hide advanced" : "a — advanced"}
        </Text>
      </Box>
    </Box>
  );
}

function SetupCard({
  view,
  panel,
}: {
  view: SetupView;
  panel: TelegramPanelState;
}): ReactElement {
  const titleColor =
    view.step === "ready"
      ? theme.colors.accentSoft
      : view.step === "pairing_failed"
        ? theme.colors.error
        : theme.colors.accentSoft;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={titleColor}
      paddingX={1}
    >
      <Text bold color={titleColor}>
        {view.title}
      </Text>
      <Text color={theme.colors.muted}>{view.body}</Text>
      {view.cta ? (
        <Box marginTop={1}>
          <Text color={theme.colors.accentSoft}>{view.cta}</Text>
        </Box>
      ) : null}
      {view.step === "ready" && panel.botId !== null ? (
        <Text color={theme.colors.muted}>bot id {panel.botId}</Text>
      ) : null}
    </Box>
  );
}

function PairingSuccessCard({
  userId,
  welcomeDelivered,
}: {
  userId: number;
  welcomeDelivered: boolean;
}): ReactElement {
  // The runtime persisted the new owner before we render this card,
  // so the headline is unconditional. The body, however, only claims
  // delivery when sendMessage actually resolved — otherwise we tell
  // the operator to verify by DMing the bot once.
  const borderColor = welcomeDelivered
    ? theme.colors.accentSoft
    : theme.colors.muted;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold color={theme.colors.accentSoft}>
        ✅ Owner confirmed
      </Text>
      <Text color={theme.colors.muted}>
        {welcomeDelivered
          ? `Welcome message sent to user ${userId} in Telegram.`
          : `Owner saved as user ${userId}. The Telegram confirmation didn't go through — DM the bot once to verify.`}
      </Text>
      <Text color={theme.colors.muted}>press any key to close…</Text>
    </Box>
  );
}

function AdvancedControls({
  panel,
}: {
  panel: TelegramPanelState;
}): ReactElement {
  const stateColor = colorForState(panel.channelState);
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.colors.muted}>state </Text>
        <Text color={stateColor} bold>
          {panel.channelState}
        </Text>
        <Text color={theme.colors.muted}>{"   "}enabled </Text>
        <Text
          color={panel.enabled ? theme.colors.accentSoft : theme.colors.muted}
        >
          {panel.enabled ? "yes" : "no"}
        </Text>
        <Text color={theme.colors.muted}>{"   "}token </Text>
        <Text
          color={panel.hasToken ? theme.colors.accentSoft : theme.colors.error}
        >
          {panel.hasToken ? "set" : "missing"}
        </Text>
        <Text color={theme.colors.muted}>{"   "}owner </Text>
        <Text
          color={
            panel.ownerUserId === null
              ? theme.colors.error
              : theme.colors.accentSoft
          }
        >
          {panel.ownerUserId === null ? "unset" : String(panel.ownerUserId)}
        </Text>
      </Box>
      {panel.lastError ? (
        <Text color={theme.colors.error}>! {panel.lastError}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>
          e — {panel.enabled ? "disable" : "enable"} · r — restart · R — refresh
        </Text>
        <Text color={theme.colors.muted}>
          T — clear token · O — clear owner · t — change token · o — re-pair
        </Text>
      </Box>
      {panel.message ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>· {panel.message}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function colorForState(
  state: TelegramPanelState["channelState"],
): string {
  switch (state) {
    case "up":
      return theme.colors.accentSoft;
    case "starting":
    case "stopping":
      return theme.colors.muted;
    case "down":
      return theme.colors.error;
    case "disabled":
    default:
      return theme.colors.muted;
  }
}
