import type { SessionPickerEntry } from "../tui-state.js";
import {
  persistSessionRailLayout,
  readSessionRailLayout,
} from "./persist-session-rail.js";
import {
  arrangeSessionRail,
  computeDroppedLayout,
  togglePinned,
  type SessionRailLayout,
} from "./session-rail-pin.js";

/**
 * Where the layout (manual order + pinned ids) lives. Injectable so
 * orchestrator tests stay hermetic — the default reads and writes the
 * user's `config.json`.
 */
export interface SessionRailLayoutStore {
  read(): SessionRailLayout;
  write(layout: SessionRailLayout): void;
}

export const configSessionRailLayoutStore: SessionRailLayoutStore = {
  read: readSessionRailLayout,
  write: persistSessionRailLayout,
};

/**
 * Build the row for a session the incoming list does not carry, or
 * `null` when it no longer exists. Injected so tests never touch a
 * session store.
 */
export type SessionRailEntryLoader = (
  sessionId: string,
) => SessionPickerEntry | null;

/**
 * The rail's layout, owned by the chat orchestrator.
 *
 * `arrange` is the one hook in `railSessions()`: it applies the stored
 * layout and remembers what was emitted, so a later `moveSession` or
 * `togglePinned` can compute the new layout against exactly the list
 * the operator saw — the row indices the keyboard and the mouse hand
 * over are indices into THAT list, pending stand-ins included. The
 * first move or pin persists the whole displayed list, which is the
 * "snapshot on first touch" that turns a recency-sorted rail into a
 * manual one.
 *
 * A pinned id the incoming list lacks — a thread older than the
 * recency window — is fetched through `loadEntry` before arranging, so
 * a pin is never lost to age. A pin on a deleted session loads nothing
 * and is pruned on the next write.
 */
export class SessionRailOrchestrator {
  private lastRail: readonly SessionPickerEntry[] = [];

  constructor(
    private readonly store: SessionRailLayoutStore,
    private readonly refresh: () => void,
    private readonly loadEntry: SessionRailEntryLoader = () => null,
  ) {}

  /** Apply the remembered layout to the list about to be emitted. */
  arrange(entries: readonly SessionPickerEntry[]): SessionPickerEntry[] {
    const layout = this.store.read();
    const pinned = new Set(layout.pinned);
    const present = new Set(entries.map((entry) => entry.sessionId));
    const missing: SessionPickerEntry[] = [];
    for (const id of layout.pinned) {
      if (present.has(id)) continue;
      const loaded = this.loadEntry(id);
      if (loaded) missing.push(loaded);
    }
    const arranged = arrangeSessionRail([...entries, ...missing], layout).map(
      (entry) => ({ ...entry, pinned: pinned.has(entry.sessionId) }),
    );
    this.lastRail = arranged;
    return arranged;
  }

  /**
   * Drop `sessionId` on slot `toIndex` of the displayed list, persist,
   * re-emit. The slot decides the pin: inside the pinned block pins,
   * below it unpins — the keyboard never asks for a crossing move, so
   * this is the drag's rule.
   */
  moveSession(sessionId: string, toIndex: number): void {
    const next = computeDroppedLayout(
      this.store.read(),
      this.displayedIds(),
      sessionId,
      toIndex,
    );
    if (!next) return;
    this.store.write(next);
    this.refresh();
  }

  /** Pin `sessionId` to the end of the block, or release it to the top of the rest. */
  togglePinned(sessionId: string): void {
    const next = togglePinned(
      this.store.read(),
      this.displayedIds(),
      sessionId,
    );
    if (!next) return;
    this.store.write(next);
    this.refresh();
  }

  private displayedIds(): string[] {
    return this.lastRail.map((entry) => entry.sessionId);
  }
}
