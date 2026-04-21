import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { TuiState } from "./tui-state.js";

interface MetricsFooterProps {
  state: TuiState;
}

export function MetricsFooter({ state }: MetricsFooterProps): ReactElement {
  const { metrics } = state;
  const kvTotal = metrics.kvCacheHits + metrics.kvCacheMisses;
  const kvHitRate =
    kvTotal === 0 ? "—" : `${Math.round((metrics.kvCacheHits / kvTotal) * 100)}%`;
  const stepDur = metrics.stepDurationMsLast ?? "—";
  const llmDur = metrics.llmDurationMsLast ?? "—";
  const prompt = metrics.promptTokensLast ?? "—";
  const completion = metrics.completionTokensLast ?? "—";
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="gray">tokens: </Text>
        <Text>p{prompt} / c{completion}</Text>
        <Text color="gray"> · total </Text>
        <Text>{metrics.totalTokens}</Text>
      </Text>
      <Text>
        <Text color="gray">latency: </Text>
        <Text>llm {llmDur}ms · step {stepDur}ms</Text>
      </Text>
      <Text>
        <Text color="gray">kv: </Text>
        <Text>{kvHitRate}</Text>
        <Text color="gray"> ({metrics.kvCacheHits}/{kvTotal})</Text>
      </Text>
      <Text>
        <Text color="gray">tools: </Text>
        <Text color="green">{metrics.toolsOk}</Text>
        <Text>/</Text>
        <Text color="red">{metrics.toolsError}</Text>
      </Text>
    </Box>
  );
}
