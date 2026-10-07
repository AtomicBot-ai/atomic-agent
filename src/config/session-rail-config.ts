import { ConfigValidationError } from "./config-validation-error.js";

/**
 * The rail's Sessions list order, as the operator arranged it.
 *
 * Empty means the list is sorted by recency, the way it always was. The
 * first Shift+↑/↓ or row drag snapshots the list as displayed into
 * `order`; from then on those ids keep this order and sessions the list
 * has never seen (a newer thread, an id not in `order`) are inserted at
 * the top. Ids that no longer exist are ignored on read and dropped on
 * the next write.
 */
export interface SessionRailConfig {
  order: string[];
  /**
   * Session ids pinned to the top of the rail (config v53). Pinned rows
   * form a block above everything else; inside the block they follow
   * `order` like any other row. A pinned id that no longer exists is
   * ignored on read and dropped on the next write.
   */
  pinned: string[];
}

/**
 * Parse `tui.sessionRail`. Absent → the recency default, nothing pinned.
 * `order` and `pinned` are lists of session ids; entries that are not
 * non-empty strings are dropped rather than rejected — a hand-edited or
 * partially written id costs one row its remembered place, not the
 * whole config file — and duplicates keep their first position so the
 * on-disk form stays canonical.
 */
export function parseSessionRailConfig(raw: unknown): SessionRailConfig {
  if (raw === undefined || raw === null) return { order: [], pinned: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "tui.sessionRail",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const block = raw as Record<string, unknown>;
  return {
    order: parseSessionIdList(block.order, "tui.sessionRail.order"),
    pinned: parseSessionIdList(block.pinned, "tui.sessionRail.pinned"),
  };
}

function parseSessionIdList(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      path,
      `expected string[], got ${JSON.stringify(raw)}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}
