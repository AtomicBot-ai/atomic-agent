import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import { namesHintLine } from "../privacy-names.js";
import type { ShieldPanelState } from "../privacy-shield.js";

/**
 * The names row under Privacy Shield (ATO-2527): on/off for hiding
 * people's names, street addresses and organisations with a local model,
 * and a line saying which model reads the text and what happens without
 * one. Nothing is drawn when the agent has no such switch.
 */
export function PrivacyNamesSection({
  shield,
  busy,
}: {
  shield: ShieldPanelState;
  busy: boolean;
}): ReactElement | null {
  const names = shield.names;
  if (!names) return null;
  return (
    <Box flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{"   "}names, addresses, organisations </Text>
        <Text color={names.enabled ? theme.colors.accentSoft : theme.colors.muted}>
          {names.enabled ? "on" : "off"}
        </Text>
        {busy ? <Text color={theme.colors.muted}>{"  "}…</Text> : null}
      </Box>
      <Box>
        <Text color={names.state === "no-local-model" || names.state === "provider-not-shielded" ? theme.colors.warn : theme.colors.muted}>
          {"   "}
          {namesHintLine(names, shield.enabled)}
        </Text>
      </Box>
    </Box>
  );
}
