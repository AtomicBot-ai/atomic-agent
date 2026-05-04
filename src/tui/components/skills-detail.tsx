import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { SkillsPanelState } from "../skills/skills-panel-state.js";

export interface SkillsDetailProps {
  panel: SkillsPanelState;
  maxBodyLines?: number;
}

const DEFAULT_MAX_BODY_LINES = 32;

/**
 * Detail view for one skill: header (name + state + source + version)
 * followed by the SKILL.md body (truncated to `maxBodyLines` so a long
 * playbook never blows out the debug pane).
 */
export function SkillsDetail(props: SkillsDetailProps): ReactElement {
  const { panel, maxBodyLines = DEFAULT_MAX_BODY_LINES } = props;
  const name = panel.detailName;
  if (!name) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.colors.muted}>(no skill selected)</Text>
      </Box>
    );
  }
  const row = panel.rows.find((r) => r.name === name);
  const stateLabel = row?.disabled ? "disabled" : "enabled";
  const stateColor = row?.disabled ? theme.colors.warn : theme.colors.success;
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{name}</Text>
        <Text color={theme.colors.muted}>{"  "}</Text>
        <Text color={stateColor}>{stateLabel}</Text>
        {row ? (
          <Text color={theme.colors.muted}>
            {"  "}[{row.source}] v{row.version}
          </Text>
        ) : null}
      </Box>
      {row?.description ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>{row.description}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {renderBody(panel.detailBody, maxBodyLines)}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          Esc back · e toggle · r refresh
        </Text>
      </Box>
    </Box>
  );
}

function renderBody(
  body: string | null,
  maxLines: number,
): ReactElement {
  if (body === null) {
    return <Text color={theme.colors.muted}>(loading…)</Text>;
  }
  const lines = body.split("\n");
  const head = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;
  return (
    <Box flexDirection="column">
      {head.map((line, idx) => (
        <Text key={idx}>{line.length === 0 ? " " : line}</Text>
      ))}
      {truncated ? (
        <Text color={theme.colors.muted}>
          … ({lines.length - maxLines} more line{lines.length - maxLines === 1 ? "" : "s"} hidden)
        </Text>
      ) : null}
    </Box>
  );
}
