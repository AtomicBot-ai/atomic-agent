import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Logo } from "./logo.js";
import { theme } from "../theme/theme.js";

/**
 * Welcome screen shown in place of an empty chat-log. Renders the brand
 * `Logo` (atomic-plus mark + wordmark) vertically centred via flexGrow
 * spacers, with a compact tip-list underneath that surfaces the most
 * useful slash commands and hotkeys.
 *
 * Visibility is decided by the parent (`ChatLog`) based on
 * `messages.length === 0`, so restoring a historical session via
 * `/sessions` swaps the banner out for the transcript.
 */
export function SplashBanner(): ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" paddingX={2}>
      <Box flexGrow={1} />
      <Logo />
      <Box marginTop={1} flexDirection="column">
        <Tip left="Enter" right="submit message to the agent" />
        <Tip left="/help" right="list all slash commands" />
        <Tip left="/sessions" right="switch to a previous thread" />
        <Tip left="/observe" right="view diagnostics and world state" />
        <Tip left="/manage" right="jump to the Manage tab" />
        <Tip left="/new" right="start a fresh session" />
        <Tip left="/model" right="change the chat model" />
        <Tip left="/tasks" right="jump to the Tasks tab (Option 4 cron + ingress UI)" />
        <Tip left="/import" right="open the Import tab (one-shot Hermes -> atomic-agent migration)" />
        <Tip left="/run" right="start a new run" />
        <Tip left="Ctrl+C ×2" right="quit (once aborts a running turn)" />
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}

interface TipProps {
  left: string;
  right: string;
}

function Tip({ left, right }: TipProps): ReactElement {
  return (
    <Text>
      <Text color={theme.colors.muted}>  {theme.glyphs.bullet} </Text>
      <Text color={theme.colors.accent}>{left.padEnd(24, " ")}</Text>
      <Text color={theme.colors.muted}>{right}</Text>
    </Text>
  );
}
