import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ReactElement } from "react";
import type { TuiState } from "./tui-state.js";
import { canAcceptMessage } from "./tui-state.js";

interface GoalInputProps {
  state: TuiState;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function GoalInput({ state, onChange, onSubmit }: GoalInputProps): ReactElement {
  const enabled = canAcceptMessage(state);
  const placeholder = placeholderFor(state);
  return (
    <Box borderStyle="round" borderColor={enabled ? "cyan" : "gray"} paddingX={1}>
      <Text color={enabled ? "cyan" : "gray"}>❯ </Text>
      {enabled ? (
        <TextInput
          value={state.inputValue}
          placeholder={placeholder}
          onChange={onChange}
          onSubmit={handleSubmit(onSubmit)}
          showCursor
        />
      ) : (
        <Text color="gray">{placeholder}</Text>
      )}
    </Box>
  );
}

/**
 * Silently ignore empty submissions so a stray Enter press does not spawn
 * a meaningless turn. Trimming also cleans trailing whitespace that would
 * break byte-stability of the stable prefix if it leaked into the prompt.
 */
function handleSubmit(onSubmit: (value: string) => void): (raw: string) => void {
  return (raw) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };
}

function placeholderFor(state: TuiState): string {
  if (state.status === "running") {
    return state.aborting ? "aborting current turn…" : "agent is running…";
  }
  if (state.status === "awaiting_approval") {
    return "approval required — decide in modal above";
  }
  if (state.status === "quitting") {
    return "exiting…";
  }
  return state.runHistory.length === 0
    ? "type a message and press Enter (ctrl+c to quit)"
    : "next message… (ctrl+c to quit)";
}
