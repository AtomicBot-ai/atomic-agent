import type { SessionPickerEntry } from "../tui-state.js";
import {
  persistSessionRailOrder,
  readSessionRailOrder,
} from "./persist-session-rail.js";
import {
  applySessionRailOrder,
  computeMovedOrder,
} from "./session-rail-order.js";

/**
 * Where the manual order lives. Injectable so orchestrator tests stay
 * hermetic — the default reads and writes the user's `config.json`.
 */
export interface SessionRailOrderStore {
  read(): readonly string[];
  write(order: readonly string[]): void;
}

export const configSessionRailOrderStore: SessionRailOrderStore = {
  read: readSessionRailOrder,
  write: persistSessionRailOrder,
};

/**
 * The rail's order, owned by the chat orchestrator.
 *
 * `arrange` is the one hook in `railSessions()`: it applies the stored
 * order and remembers what was emitted, so a later `moveSession` can
 * compute the new order against exactly the list the operator saw —
 * the row indices the keyboard and the mouse hand over are indices
 * into THAT list, pending stand-ins included. The first move persists
 * the whole displayed list, which is the "snapshot on first touch"
 * that turns a recency-sorted rail into a manual one.
 */
export class SessionRailOrchestrator {
  private lastRail: readonly SessionPickerEntry[] = [];

  constructor(
    private readonly store: SessionRailOrderStore,
    private readonly refresh: () => void,
  ) {}

  /** Apply the remembered order to the list about to be emitted. */
  arrange(entries: readonly SessionPickerEntry[]): SessionPickerEntry[] {
    const arranged = applySessionRailOrder(entries, this.store.read());
    this.lastRail = arranged;
    return arranged;
  }

  /** Drop `sessionId` on slot `toIndex` of the displayed list, persist, re-emit. */
  moveSession(sessionId: string, toIndex: number): void {
    const displayed = this.lastRail.map((entry) => entry.sessionId);
    const next = computeMovedOrder(displayed, sessionId, toIndex);
    if (!next) return;
    this.store.write(next);
    this.refresh();
  }
}
