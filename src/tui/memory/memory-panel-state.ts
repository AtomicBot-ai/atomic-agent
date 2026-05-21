/**
 * Local UI state for the TUI "Memory" tab. Folded by `memory-reducer.ts`
 * from `memory_*` actions emitted by the orchestrator and keyboard layer.
 */
export type MemoryPanelMode = "list" | "detail";

export type MemoryChannel =
  | "profile"
  | "notes"
  | "lessons"
  | "procedures"
  | "links"
  | "votes";

export const MEMORY_CHANNEL_ORDER: readonly MemoryChannel[] = [
  "profile",
  "notes",
  "lessons",
  "procedures",
  "links",
  "votes",
] as const;

/** Notes list filter — archived rows require `excludeArchived: false`. */
export type MemoryNotesArchiveFilter = "active" | "archived" | "all";

export interface MemoryLinkNeighbor {
  memoryId: number;
  kind: string;
  direction: "out" | "in";
}

export type MemoryDetailPayload =
  | {
      channel: "profile";
      key: string;
      body: string;
    }
  | {
      channel: "notes";
      id: number;
      body: string;
      tags: readonly string[];
      consolidatedInto: number | null;
      outgoing: readonly MemoryLinkNeighbor[];
      incoming: readonly MemoryLinkNeighbor[];
      expandedNeighbors: readonly number[];
    }
  | {
      channel: "lessons";
      id: number;
      body: string;
    }
  | {
      channel: "procedures";
      id: number;
      body: string;
    }
  | {
      channel: "votes";
      body: string;
    }
  | {
      channel: "links";
      body: string;
    };

/**
 * Compact row rendered in the list view. `rowKey` is unique within a
 * refresh snapshot (used as React `key` and for detail lookup).
 */
export interface MemorySummaryRow {
  rowKey: string;
  channel: MemoryChannel;
  primary: string;
  secondary: string;
  meta: string;
  profileKey?: string;
  numericId?: number;
  linkFromId?: number;
  linkToId?: number;
  voteEventId?: number;
}

export interface MemoryPanelState {
  mode: MemoryPanelMode;
  channel: MemoryChannel;
  /** Channels the orchestrator last reported as available (config gates). */
  availableChannels: readonly MemoryChannel[];
  rows: readonly MemorySummaryRow[];
  cursor: number;
  searchQuery: string;
  notesArchiveFilter: MemoryNotesArchiveFilter;
  lastRefreshedAt: number | null;
  loading: boolean;
  autoRefresh: boolean;
  detailRowKey: string | null;
  detail: MemoryDetailPayload | null;
  lastError: string | null;
  /** Shown when a config gate disables the active channel. */
  channelHint: string | null;
}

export function createInitialMemoryPanelState(): MemoryPanelState {
  return {
    mode: "list",
    channel: "profile",
    availableChannels: [...MEMORY_CHANNEL_ORDER],
    rows: [],
    cursor: 0,
    searchQuery: "",
    notesArchiveFilter: "active",
    lastRefreshedAt: null,
    loading: false,
    autoRefresh: true,
    detailRowKey: null,
    detail: null,
    lastError: null,
    channelHint: null,
  };
}
