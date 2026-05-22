import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { LINK_LIST_ALL_DEFAULT_LIMIT } from "../../memory/links/link-store.js";
import type { TuiEventBus } from "../tui-app.js";
import { isMemoryAction } from "./memory-actions.js";
import {
  formatLessonDetailBody,
  formatNoteDetailBody,
  formatProcedureDetailBody,
  formatProfileHistoryBody,
  formatVoteDetailBody,
  linkRowsToNeighbors,
} from "./memory-detail-text.js";
import type {
  MemoryChannel,
  MemoryDetailPayload,
  MemoryNotesArchiveFilter,
  MemorySummaryRow,
} from "./memory-panel-state.js";
import {
  toLessonSummaryRows,
  toLinkSummaryRows,
  toNoteSummaryRows,
  toNoteSummaryRowsFromEntries,
  toProcedureSummaryRows,
  toProfileSummaryRows,
  toVoteSummaryRows,
} from "./memory-summary.js";

export interface MemoryOrchestratorOptions {
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const NOTES_LIST_LIMIT = 200;

export class MemoryOrchestrator {
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;
  private lastRefreshOpts: {
    channel: MemoryChannel;
    notesArchiveFilter: MemoryNotesArchiveFilter;
    searchQuery: string;
  } = {
    channel: "profile",
    notesArchiveFilter: "active",
    searchQuery: "",
  };

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    options: MemoryOrchestratorOptions = {},
  ) {
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.bus.subscribe((action) => {
      if (!isMemoryAction(action)) return;
      if (action.type === "memory_refresh_requested") {
        this.refresh({
          channel: action.channel,
          notesArchiveFilter: action.notesArchiveFilter,
          searchQuery: action.searchQuery,
        });
      }
    });
  }

  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refresh();
    this.refreshTimer = setInterval(
      () => this.refresh(),
      this.refreshIntervalMs,
    );
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  refresh(opts: {
    channel?: MemoryChannel;
    notesArchiveFilter?: MemoryNotesArchiveFilter;
    searchQuery?: string;
  } = {}): void {
    try {
      this.lastRefreshOpts = {
        channel: opts.channel ?? this.lastRefreshOpts.channel,
        notesArchiveFilter:
          opts.notesArchiveFilter ?? this.lastRefreshOpts.notesArchiveFilter,
        searchQuery: opts.searchQuery ?? this.lastRefreshOpts.searchQuery,
      };
      this.bus.emit({ type: "memory_refresh_started" });
      const available = resolveAvailableChannels(this.runtime);
      const activeChannel =
        this.lastRefreshOpts.channel ?? available[0] ?? "profile";
      const { rows, hint } = loadChannelRows(this.runtime, activeChannel, {
        notesArchiveFilter: this.lastRefreshOpts.notesArchiveFilter,
        searchQuery: this.lastRefreshOpts.searchQuery,
      });
      this.bus.emit({
        type: "memory_rows_loaded",
        rows,
        availableChannels: available,
        channelHint: hint,
        at: Date.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "memory_refresh_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `memory refresh failed: ${msg}`,
      });
    }
  }

  openDetail(row: MemorySummaryRow): void {
    try {
      const detail = buildDetail(this.runtime, row);
      if (!detail) {
        this.bus.emit({
          type: "runtime_info",
          line: `memory detail unavailable for ${row.rowKey}`,
        });
        return;
      }
      this.bus.emit({
        type: "memory_detail_opened",
        rowKey: row.rowKey,
        detail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "memory_refresh_failed", error: msg });
    }
  }

  openNoteById(noteId: number): void {
    const row: MemorySummaryRow = {
      rowKey: `note:${noteId}`,
      channel: "notes",
      primary: `#${noteId}`,
      secondary: "",
      meta: "",
      numericId: noteId,
    };
    this.openDetail(row);
  }

  expandNoteNeighbors(noteId: number): void {
    if (!this.runtime.config.memory.links.enabled) return;
    const expanded = this.runtime.linkStore.expand([noteId], {
      depth: 2,
      maxExpanded: 24,
    });
    const entry = this.runtime.notesStore.get(noteId);
    if (!entry) return;
    const outgoing = this.runtime.linkStore.listOutgoing(noteId);
    const incoming = this.runtime.linkStore.listIncoming(noteId);
    const neighbors = linkRowsToNeighbors(outgoing, incoming);
    const next: MemoryDetailPayload = {
      channel: "notes",
      id: noteId,
      body: formatNoteDetailBody(
        entry,
        this.runtime.notesStore.getConsolidatedInto(noteId),
        outgoing,
        incoming,
        expanded,
      ),
      tags: entry.tags,
      consolidatedInto: this.runtime.notesStore.getConsolidatedInto(noteId),
      outgoing: neighbors.outgoing,
      incoming: neighbors.incoming,
      expandedNeighbors: expanded,
    };
    this.bus.emit({ type: "memory_detail_neighbors_updated", detail: next });
  }
}

function resolveAvailableChannels(runtime: AgentRuntime): MemoryChannel[] {
  const cfg = runtime.config.memory;
  const out: MemoryChannel[] = ["profile", "notes"];
  if (cfg.lessons.enabled) out.push("lessons");
  if (cfg.procedures.enabled) out.push("procedures");
  if (cfg.links.enabled) out.push("links");
  if (runtime.voteStore !== null) out.push("votes");
  return out;
}

function loadChannelRows(
  runtime: AgentRuntime,
  channel: MemoryChannel,
  opts: {
    notesArchiveFilter: MemoryNotesArchiveFilter;
    searchQuery: string;
  },
): { rows: MemorySummaryRow[]; hint: string | null } {
  const cfg = runtime.config.memory;
  switch (channel) {
    case "profile":
      if (!cfg.profile.enabled) {
        return {
          rows: [],
          hint: "memory.profile.enabled=false — enable in config to populate profile",
        };
      }
      return { rows: toProfileSummaryRows(runtime.profileStore.list()), hint: null };
    case "notes": {
      if (!cfg.notes.enabled) {
        return {
          rows: [],
          hint: "memory.notes.enabled=false — enable in config to store notes",
        };
      }
      const q = opts.searchQuery.trim();
      if (q.length > 0) {
        const hits = runtime.notesStore.recall(q, { k: 50 });
        return { rows: toNoteSummaryRowsFromEntries(hits), hint: null };
      }
      if (opts.notesArchiveFilter === "archived") {
        const entries = runtime.notesStore.list({ limit: NOTES_LIST_LIMIT });
        const archived = entries.filter(
          (e) => runtime.notesStore.getConsolidatedInto(e.id) !== null,
        );
        return { rows: toNoteSummaryRowsFromEntries(archived), hint: null };
      }
      const index = runtime.notesStore.listIndex({
        limit: NOTES_LIST_LIMIT,
        excludeArchived: opts.notesArchiveFilter === "active",
      });
      return { rows: toNoteSummaryRows(index), hint: null };
    }
    case "lessons":
      if (!cfg.lessons.enabled) {
        return { rows: [], hint: "memory.lessons.enabled=false" };
      }
      return {
        rows: toLessonSummaryRows(
          runtime.lessonStore.listIndex({ limit: NOTES_LIST_LIMIT }),
        ),
        hint: null,
      };
    case "procedures":
      if (!cfg.procedures.enabled) {
        return { rows: [], hint: "memory.procedures.enabled=false" };
      }
      return {
        rows: toProcedureSummaryRows(
          runtime.procedureStore.listIndex({ limit: NOTES_LIST_LIMIT }),
        ),
        hint: null,
      };
    case "links":
      if (!cfg.links.enabled) {
        return { rows: [], hint: "memory.links.enabled=false" };
      }
      return {
        rows: toLinkSummaryRows(
          runtime.linkStore.listAll({ limit: LINK_LIST_ALL_DEFAULT_LIMIT }),
        ),
        hint: null,
      };
    case "votes": {
      if (runtime.voteStore === null) {
        return { rows: [], hint: "memory.voting.enabled=false" };
      }
      return {
        rows: toVoteSummaryRows(runtime.voteStore.listEvents({ limit: 100 })),
        hint: null,
      };
    }
  }
}

function buildDetail(
  runtime: AgentRuntime,
  row: MemorySummaryRow,
): MemoryDetailPayload | null {
  switch (row.channel) {
    case "profile": {
      const key = row.profileKey;
      if (!key) return null;
      const chain = runtime.profileStore.history(key);
      return {
        channel: "profile",
        key,
        body: formatProfileHistoryBody(key, chain),
      };
    }
    case "notes": {
      const id = row.numericId;
      if (id === undefined) return null;
      const entry = runtime.notesStore.get(id);
      if (!entry) return null;
      const outgoing = runtime.config.memory.links.enabled
        ? runtime.linkStore.listOutgoing(id)
        : [];
      const incoming = runtime.config.memory.links.enabled
        ? runtime.linkStore.listIncoming(id)
        : [];
      const neighbors = linkRowsToNeighbors(outgoing, incoming);
      return {
        channel: "notes",
        id,
        body: formatNoteDetailBody(
          entry,
          runtime.notesStore.getConsolidatedInto(id),
          outgoing,
          incoming,
          [],
        ),
        tags: entry.tags,
        consolidatedInto: runtime.notesStore.getConsolidatedInto(id),
        outgoing: neighbors.outgoing,
        incoming: neighbors.incoming,
        expandedNeighbors: [],
      };
    }
    case "lessons": {
      const id = row.numericId;
      if (id === undefined) return null;
      const lesson = runtime.lessonStore.getById(id);
      if (!lesson) return null;
      return { channel: "lessons", id, body: formatLessonDetailBody(lesson) };
    }
    case "procedures": {
      const id = row.numericId;
      if (id === undefined) return null;
      const proc = runtime.procedureStore.getById(id);
      if (!proc) return null;
      return { channel: "procedures", id, body: formatProcedureDetailBody(proc) };
    }
    case "links": {
      const from = row.linkFromId;
      const to = row.linkToId;
      if (from === undefined || to === undefined) return null;
      return {
        channel: "links",
        body: `edge: #${from} → #${to}\n${row.secondary}\n\nPress Enter on from-id to open note #${from}.`,
      };
    }
    case "votes": {
      const eventId = row.voteEventId;
      const events = runtime.voteStore?.listEvents({ limit: 100 }) ?? [];
      const event =
        eventId !== undefined
          ? events.find((e) => e.id === eventId)
          : undefined;
      if (!event) return { channel: "votes", body: row.primary };
      return {
        channel: "votes",
        body: formatVoteDetailBody(event, resolveVoteTargetPreview(runtime, event)),
      };
    }
  }
}

function resolveVoteTargetPreview(
  runtime: AgentRuntime,
  event: { kind: string; targetId: number },
): string | null {
  switch (event.kind) {
    case "memory": {
      const e = runtime.notesStore.get(event.targetId);
      return e ? truncate(e.content, 400) : null;
    }
    case "lesson": {
      const l = runtime.lessonStore.getById(event.targetId);
      return l ? truncate(l.principle, 400) : null;
    }
    case "procedure": {
      const p = runtime.procedureStore.getById(event.targetId);
      return p ? truncate(p.activation, 400) : null;
    }
    case "profile": {
      const f = runtime.profileStore.getById(event.targetId);
      return f ? `${f.key}=${f.value}` : null;
    }
    default:
      return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
