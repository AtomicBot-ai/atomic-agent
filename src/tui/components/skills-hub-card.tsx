import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { formatDownloads } from "../skills/format-downloads.js";
import {
  HUB_CARD_BODY_WINDOW,
  type HubCardState,
} from "../skills/skills-panel-state.js";

export interface SkillsHubCardProps {
  card: HubCardState;
  installing: boolean;
  /** First visible SKILL.md line (scroll offset, clamped by the reducer). */
  scroll: number;
  /** Last install error, surfaced under the card body. */
  installError?: string | null;
  maxBodyLines?: number;
}

/**
 * Pre-install skill card. Opened on Enter over a hub row: shows catalog
 * metadata (name, owner, downloads, version, summary) and the full
 * SKILL.md pulled from the registry before any download. `i`/`y` stage +
 * install (which then runs the security scan), `n`/Esc returns to the
 * list.
 */
export function SkillsHubCard(props: SkillsHubCardProps): ReactElement {
  const {
    card,
    installing,
    scroll,
    installError = null,
    maxBodyLines = HUB_CARD_BODY_WINDOW,
  } = props;
  const badge = card.source === "clawhub" ? "claw" : "gh";
  const badgeColor =
    card.source === "clawhub" ? theme.colors.accent : theme.colors.muted;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
    >
      <Box>
        <Text color={badgeColor}>[{badge}] </Text>
        <Text bold>{card.name}</Text>
        <Text color={theme.colors.muted}>
          {"  "}
          {card.identifier}
        </Text>
      </Box>
      <Box>
        <Text color={theme.colors.muted}>
          owner {card.repo} · ↓{formatDownloads(card.downloads)} · v
          {card.version}
        </Text>
      </Box>
      {card.description ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>{card.description}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {renderBody(card, scroll, maxBodyLines)}
      </Box>
      {installError ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>! install failed: {installError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {installing ? (
          <Text color={theme.colors.muted}>installing…</Text>
        ) : (
          <Text color={theme.colors.muted}>
            [i] install · [n] cancel · j/k scroll
          </Text>
        )}
      </Box>
    </Box>
  );
}

function renderBody(
  card: HubCardState,
  scroll: number,
  maxLines: number,
): ReactElement {
  if (card.body === null) {
    return (
      <Text color={theme.colors.muted}>
        {card.bodyError ?? "loading SKILL.md…"}
      </Text>
    );
  }
  const lines = card.body.split("\n");
  const start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - maxLines)));
  const window = lines.slice(start, start + maxLines);
  const above = start;
  const below = Math.max(0, lines.length - (start + window.length));
  return (
    <Box flexDirection="column">
      {above > 0 ? (
        <Text color={theme.colors.muted}>
          ↑ {above} more line{above === 1 ? "" : "s"} above
        </Text>
      ) : null}
      {window.map((line, idx) => (
        <Text key={start + idx}>{line.length === 0 ? " " : line}</Text>
      ))}
      {below > 0 ? (
        <Text color={theme.colors.muted}>
          ↓ {below} more line{below === 1 ? "" : "s"} below
        </Text>
      ) : null}
    </Box>
  );
}
