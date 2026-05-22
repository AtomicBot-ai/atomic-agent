import type { LinkRow } from "../../memory/links/link-store.js";
import { renderNotePreview } from "../../memory/memory-store.js";
import type { MemoryEntry, MemoryIndexEntry } from "../../memory/memory-store.js";
import type { LessonIndexEntry } from "../../memory/lessons/lesson-store.js";
import type { ProcedureIndexEntry } from "../../memory/procedures/procedure-store.js";
import type { ProfileFact } from "../../memory/profile-store.js";
import type { VoteEventRow } from "../../memory/voting/vote-store.js";
import type { MemorySummaryRow } from "./memory-panel-state.js";

export function toProfileSummaryRows(
  facts: readonly ProfileFact[],
): MemorySummaryRow[] {
  return facts.map((f) => ({
    rowKey: `profile:${f.key}`,
    channel: "profile" as const,
    primary: f.key,
    secondary: truncate(f.value, 56),
    meta: [
      f.pinned ? "pinned" : "contextual",
      f.voteScore !== 0 ? `vote ${formatVote(f.voteScore)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    profileKey: f.key,
  }));
}

export function toNoteSummaryRowsFromEntries(
  entries: readonly MemoryEntry[],
): MemorySummaryRow[] {
  return entries.map((e) => ({
    rowKey: `note:${e.id}`,
    channel: "notes" as const,
    primary: `#${e.id}`,
    secondary: truncate(renderNotePreview(e.content, 80), 56),
    meta: formatTagsMeta(e.tags),
    numericId: e.id,
  }));
}

export function toNoteSummaryRows(
  entries: readonly MemoryIndexEntry[],
): MemorySummaryRow[] {
  return entries.map((e) => ({
    rowKey: `note:${e.id}`,
    channel: "notes" as const,
    primary: `#${e.id}`,
    secondary: truncate(e.preview, 56),
    meta: formatTagsMeta(e.tags),
    numericId: e.id,
  }));
}

export function toLessonSummaryRows(
  entries: readonly LessonIndexEntry[],
): MemorySummaryRow[] {
  return entries.map((e) => ({
    rowKey: `lesson:${e.id}`,
    channel: "lessons" as const,
    primary: `>${e.id}`,
    secondary: truncate(e.activation, 56),
    meta: formatTagsMeta(e.tags),
    numericId: e.id,
  }));
}

export function toProcedureSummaryRows(
  entries: readonly ProcedureIndexEntry[],
): MemorySummaryRow[] {
  return entries.map((e) => ({
    rowKey: `procedure:${e.id}`,
    channel: "procedures" as const,
    primary: `>${e.id}`,
    secondary: truncate(e.activation, 56),
    meta: formatTagsMeta(e.tags),
    numericId: e.id,
  }));
}

export function toLinkSummaryRows(
  links: readonly LinkRow[],
): MemorySummaryRow[] {
  return links.map((l) => ({
    rowKey: `link:${l.fromId}:${l.toId}:${l.kind}`,
    channel: "links" as const,
    primary: `${l.fromId} → ${l.toId}`,
    secondary: l.kind,
    meta: `w=${l.weight.toFixed(2)}`,
    linkFromId: l.fromId,
    linkToId: l.toId,
    numericId: l.fromId,
  }));
}

export function toVoteSummaryRows(
  events: readonly VoteEventRow[],
): MemorySummaryRow[] {
  return events.map((e) => ({
    rowKey: `vote:${e.id}`,
    channel: "votes" as const,
    primary: `${e.direction > 0 ? "UP" : "DOWN"} ${e.kind}:${e.targetId}`,
    secondary: e.sessionId ?? "(no session)",
    meta: `turn ${e.turnIndex ?? "—"}`,
    numericId: e.targetId,
    voteEventId: e.id,
  }));
}

function formatTagsMeta(tags: readonly string[]): string {
  if (tags.length === 0) return "";
  const head = tags.slice(0, 4).join(", ");
  return tags.length > 4 ? `${head}…` : head;
}

function formatVote(score: number): string {
  if (score > 0) return `+${score}`;
  return String(score);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
