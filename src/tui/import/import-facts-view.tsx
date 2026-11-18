import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { theme } from "../theme/theme.js";

import {
  importFactsExportLabel,
  importFactsModelLine,
  type ImportFactsUiState,
} from "./import-facts-state.js";

/**
 * "Here is what I learned about you" (ATO-1627). Rendering only; keys
 * are in import-facts-keys.ts.
 */
export function ImportFactsView({ facts, maxRows = 12 }: { facts: ImportFactsUiState; maxRows?: number }): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.accent} paddingX={1}>
      <Text bold>Facts about you from a chat export</Text>
      {facts.error ? <Text color={theme.colors.error}>! {facts.error}</Text> : null}
      {facts.phase === "form" ? <FactsForm facts={facts} /> : null}
      {facts.phase === "running" ? <FactsRunning facts={facts} /> : null}
      {facts.phase === "review" ? <FactsReview facts={facts} maxRows={maxRows} /> : null}
      {facts.phase === "done" ? <FactsDone facts={facts} /> : null}
    </Box>
  );
}

function Row({ focused, children }: { focused: boolean; children: ReactElement | string }): ReactElement {
  return (
    <Text color={focused ? theme.colors.accent : undefined}>
      {focused ? theme.glyphs.chevronRight : " "} {children}
    </Text>
  );
}

function FactsForm({ facts }: { facts: ImportFactsUiState }): ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.colors.muted}>
        A model reads only the messages you wrote (last 12 months), and lists facts about you. Nothing is saved until you tick it.
      </Text>
      <Row focused={facts.focus === "kind"}>{`export   ${importFactsExportLabel(facts.kind)}`}</Row>
      <Row focused={facts.focus === "path"}>
        {`path     ${facts.path || "(type the path of the .zip or its folder)"}${facts.focus === "path" ? theme.glyphs.promptCaret : ""}`}
      </Row>
      <Row focused={facts.focus === "cloud"}>{`[${facts.cloud ? theme.glyphs.check : " "}] use a cloud model instead`}</Row>
      <Text color={facts.cloud ? theme.colors.warn : theme.colors.muted}>    reads with: {importFactsModelLine(facts)}</Text>
      <Row focused={facts.focus === "start"}>Find facts</Row>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>↑↓ move · space toggle · type to edit · Enter on Find facts = start · Esc back</Text>
      </Box>
    </Box>
  );
}

function FactsRunning({ facts }: { facts: ImportFactsUiState }): ReactElement {
  const { chunksDone, chunksTotal, candidates } = facts.progress;
  const who = facts.readingWith
    ? `${facts.readingWith.providerId}${facts.readingWith.local ? " (local)" : " (cloud)"}`
    : "the model";
  return (
    <Box flexDirection="column">
      <Text>
        Reading your messages with {who}: part {chunksDone} of {chunksTotal || "…"}, {candidates} found
      </Text>
      <Text color={theme.colors.muted}>Esc stops and keeps what was found</Text>
    </Box>
  );
}

function FactsReview({ facts, maxRows }: { facts: ImportFactsUiState; maxRows: number }): ReactElement {
  if (facts.candidates.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>Nothing about you was found in these chats.</Text>
        <Text color={theme.colors.muted}>Esc back</Text>
      </Box>
    );
  }
  const rows = Math.max(3, Math.floor(maxRows / 2));
  const start = Math.min(Math.max(0, facts.cursor - Math.floor(rows / 2)), Math.max(0, facts.candidates.length - rows));
  const visible = facts.candidates.slice(start, start + rows);
  return (
    <Box flexDirection="column">
      <Text>
        Here is what I learned about you{facts.stopped ? " (stopped early)" : ""}: {facts.checked.length} of {facts.candidates.length} ticked
      </Text>
      {visible.map((c, i) => {
        const at = start + i;
        const on = facts.checked.includes(c.id);
        const label = c.kind === "profile" && c.key ? `${c.key}: ${c.value}` : c.value;
        return (
          <Box key={c.id} flexDirection="column">
            <Row focused={at === facts.cursor}>{`[${on ? theme.glyphs.check : " "}] ${label}`}</Row>
            <Text color={theme.colors.muted} wrap="truncate-end">      “{c.quote}”</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>↑↓ move · space tick/untick · Enter save ticked · Esc discard</Text>
      </Box>
    </Box>
  );
}

function FactsDone({ facts }: { facts: ImportFactsUiState }): ReactElement {
  const r = facts.result ?? { saved: 0, skipped: 0, conflicts: 0, failed: 0 };
  return (
    <Box flexDirection="column">
      <Text color={theme.colors.success}>
        Saved {r.saved}, skipped {r.skipped} (already known){r.conflicts ? `, ${r.conflicts} kept as they were (you set them differently)` : ""}
        {r.failed ? `, ${r.failed} failed` : ""}
      </Text>
      <Text color={theme.colors.muted}>See them with /memory. Enter or Esc to go back.</Text>
    </Box>
  );
}
