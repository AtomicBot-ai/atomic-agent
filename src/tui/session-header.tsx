import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiState } from "./tui-state.js";

interface SessionHeaderProps {
  state: TuiState;
}

const STATUS_COLOR: Record<TuiState["status"], string> = {
  idle: "gray",
  running: "cyan",
  awaiting_approval: "yellow",
  quitting: "gray",
};

export function SessionHeader({ state }: SessionHeaderProps): ReactElement {
  const { session, status, currentStep, aborting } = state;
  const statusLabel = aborting ? "aborting" : status.replace(/_/g, " ");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>atomic-agent tui</Text>
        <Text color={STATUS_COLOR[status] ?? "white"}>● {statusLabel}</Text>
      </Box>
      <Text>
        <Text color="gray">cwd:    </Text>
        {session.workingDir}
      </Text>
      <Box>
        <Text color="gray">session:</Text>
        <Text> {session.sessionId ?? "(not started)"}</Text>
        <Text color="gray">   step:</Text>
        <Text> {currentStep} / {session.maxSteps}</Text>
      </Box>
      <Box>
        <Text color="gray">llama:  </Text>
        <Text>{session.llamaUrl}</Text>
        <Text color="gray">   browser:</Text>
        <Text> {session.browserChannel}{session.browserHeadless ? " (headless)" : ""}</Text>
      </Box>
      <Box>
        <Text color="gray">skills: </Text>
        <Text>{session.skillCount} installed</Text>
        <Text color="gray">   approval:</Text>
        <Text> {session.approvalRequired ? "interactive" : "disabled"}</Text>
      </Box>
    </Box>
  );
}
