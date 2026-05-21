import type { Lesson } from "../../memory/lessons/lesson-store.js";
import type { LinkRow } from "../../memory/links/link-store.js";
import type { MemoryEntry } from "../../memory/memory-store.js";
import type { Procedure, ProcedureStep } from "../../memory/procedures/procedure-store.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import type { VoteEventRow } from "../../memory/voting/vote-store.js";
import type { MemoryLinkNeighbor } from "./memory-panel-state.js";

const MAX_DETAIL_CHARS = 12_000;

export function formatProfileHistoryBody(
  key: string,
  chain: readonly ProfileFact[],
): string {
  const lines = [`key: ${key}`, `chain (${chain.length} row${chain.length === 1 ? "" : "s"}):`, ""];
  for (const row of chain) {
    const active = row.supersededBy === null ? " (active)" : ` → #${row.supersededBy}`;
    lines.push(
      `[#${row.id}] ${new Date(row.validFrom).toISOString()}: ${row.value}${active}`,
    );
    if (!row.pinned && row.keywords.length > 0) {
      lines.push(`  keywords: ${row.keywords.join(", ")}`);
    }
    if (row.voteScore !== 0) {
      lines.push(`  vote_score: ${row.voteScore}`);
    }
  }
  return truncateDetail(lines.join("\n"));
}

export function formatNoteDetailBody(
  entry: MemoryEntry,
  consolidatedInto: number | null,
  outgoing: readonly LinkRow[],
  incoming: readonly LinkRow[],
  expandedNeighbors: readonly number[],
): string {
  const lines = [
    `#${entry.id}`,
    `source: ${entry.source}`,
    entry.sessionId ? `session: ${entry.sessionId}` : null,
    entry.workingDir ? `working_dir: ${entry.workingDir}` : null,
    `tags: ${entry.tags.length > 0 ? entry.tags.join(", ") : "(none)"}`,
    consolidatedInto !== null
      ? `archived → lesson #${consolidatedInto}`
      : null,
    `updated: ${new Date(entry.updatedAt).toISOString()}`,
    "",
    entry.content,
  ].filter((l): l is string => l !== null);
  lines.push("", formatLinkSection(outgoing, incoming, expandedNeighbors));
  return truncateDetail(lines.join("\n"));
}

export function formatLessonDetailBody(lesson: Lesson): string {
  const lines = [
    `>${lesson.id} [${lesson.status}]`,
    `activation: ${lesson.activation}`,
    `tags: ${lesson.tags.join(", ") || "(none)"}`,
    `success: ${lesson.successCount} · failure: ${lesson.failureCount}`,
    lesson.voteScore !== 0 ? `vote_score: ${lesson.voteScore}` : null,
    `parents: ${lesson.parentIds.map((id) => `#${id}`).join(", ") || "(none)"}`,
    "",
    "principle:",
    lesson.principle,
  ].filter((l): l is string => l !== null);
  return truncateDetail(lines.join("\n"));
}

export function formatProcedureDetailBody(proc: Procedure): string {
  const lines = [
    `>${proc.id} [${proc.status}]`,
    `activation: ${proc.activation}`,
    `tags: ${proc.tags.join(", ") || "(none)"}`,
    `use: ${proc.useCount} · success: ${proc.successCount} · failure: ${proc.failureCount}`,
    proc.voteScore !== 0 ? `vote_score: ${proc.voteScore}` : null,
    `parent lessons: ${proc.parentLessonIds.join(", ") || "(none)"}`,
    `parent memories: ${proc.parentMemoryIds.map((id) => `#${id}`).join(", ") || "(none)"}`,
    "",
    "steps:",
    ...proc.steps.map((step, idx) => formatProcedureStep(step, idx + 1)),
  ];
  return truncateDetail(lines.join("\n"));
}

export function formatVoteDetailBody(
  event: VoteEventRow,
  targetPreview: string | null,
): string {
  const lines = [
    `event #${event.id}`,
    `${event.direction > 0 ? "UPVOTE" : "DOWNVOTE"} ${event.kind}:${event.targetId}`,
    `session: ${event.sessionId ?? "(none)"}`,
    `turn: ${event.turnIndex ?? "—"}`,
    `at: ${new Date(event.createdAt).toISOString()}`,
    "",
    targetPreview ? `target preview:\n${targetPreview}` : "(target not found)",
  ];
  return truncateDetail(lines.join("\n"));
}

export function linkRowsToNeighbors(
  outgoing: readonly LinkRow[],
  incoming: readonly LinkRow[],
): { outgoing: MemoryLinkNeighbor[]; incoming: MemoryLinkNeighbor[] } {
  return {
    outgoing: outgoing.map((e) => ({
      memoryId: e.toId,
      kind: e.kind,
      direction: "out" as const,
    })),
    incoming: incoming.map((e) => ({
      memoryId: e.fromId,
      kind: e.kind,
      direction: "in" as const,
    })),
  };
}

function formatLinkSection(
  outgoing: readonly LinkRow[],
  incoming: readonly LinkRow[],
  expandedNeighbors: readonly number[],
): string {
  const parts: string[] = ["--- links ---"];
  if (outgoing.length === 0 && incoming.length === 0 && expandedNeighbors.length === 0) {
    parts.push("(none)");
    return parts.join("\n");
  }
  if (outgoing.length > 0) {
    parts.push("outgoing:");
    for (const e of outgoing) {
      parts.push(`  → #${e.toId} ${e.kind} (w=${e.weight})`);
    }
  }
  if (incoming.length > 0) {
    parts.push("incoming:");
    for (const e of incoming) {
      parts.push(`  ← #${e.fromId} ${e.kind} (w=${e.weight})`);
    }
  }
  if (expandedNeighbors.length > 0) {
    parts.push(`expanded (g): ${expandedNeighbors.map((id) => `#${id}`).join(", ")}`);
  }
  return parts.join("\n");
}

function formatProcedureStep(step: ProcedureStep, index: number): string {
  const hint = step.toolHint ? ` @${step.toolHint}` : "";
  return `${index}. ${step.description}${hint}`;
}

function truncateDetail(text: string): string {
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_CHARS)}\n\n[truncated]`;
}
