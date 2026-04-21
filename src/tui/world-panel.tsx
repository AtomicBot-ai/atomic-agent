import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiState } from "./tui-state.js";

interface WorldPanelProps {
  state: TuiState;
}

const SNAPSHOT_TEXT_LIMIT = 400;

export function WorldPanel({ state }: WorldPanelProps): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">── world ─────────────────────────────────────────</Text>
      <WorldSnapshotView state={state} />
      <LoadedSkillsView state={state} />
      <LatestResultView state={state} />
    </Box>
  );
}

function WorldSnapshotView({ state }: { state: TuiState }): ReactElement {
  const snapshot = state.worldSnapshot;
  if (!snapshot) {
    return <Text color="gray">worldSnapshot: none</Text>;
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="gray">snapshot: </Text>
        <Text bold>{snapshot.kind}</Text>
        <Text color="gray"> (digest {snapshot.digest.slice(0, 8)})</Text>
      </Text>
      <Text>{clip(snapshot.text, SNAPSHOT_TEXT_LIMIT)}</Text>
    </Box>
  );
}

function LoadedSkillsView({ state }: { state: TuiState }): ReactElement {
  if (state.loadedSkills.length === 0) {
    return <Text color="gray">loadedSkills: none</Text>;
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray">loadedSkills:</Text>
      {state.loadedSkills.map((skill) => (
        <Text key={skill.name}>
          {"  • "}
          <Text bold>{skill.name}</Text>
          <Text color="gray">@{skill.version}</Text>
        </Text>
      ))}
    </Box>
  );
}

function LatestResultView({ state }: { state: TuiState }): ReactElement {
  const result = state.latestResult;
  if (!result) {
    return <Text color="gray">latestResult: none</Text>;
  }
  const color = result.status === "ok" ? "green" : "red";
  return (
    <Box flexDirection="column">
      <Text color="gray">latestResult:</Text>
      <Text>
        {"  "}
        <Text color={color}>{result.status}</Text>
        <Text> </Text>
        <Text bold>{result.tool}</Text>
      </Text>
      <Text>{"  "}{clip(result.summary, SNAPSHOT_TEXT_LIMIT)}</Text>
    </Box>
  );
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
