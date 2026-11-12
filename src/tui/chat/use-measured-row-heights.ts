import { measureElement, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

interface MeasuredRows {
  /** Terminal width the rows were measured at; text wraps differently at another. */
  readonly columns: number;
  readonly rows: number;
}

export interface MeasuredRowHeights {
  /**
   * Measured rows of `id` at the current width, or `estimate()` when
   * there is none. The estimate is a thunk so a long history does not
   * re-count every message's lines on every frame.
   */
  heightOf(id: string, estimate: () => number): number;
  /** Stable ref callback for the box that wraps `id`. */
  refFor(id: string): (node: DOMElement | null) => void;
}

/**
 * Remembers how many rows each drawn chat message really took (ATO-650).
 *
 * The windowed log only lays out the messages near the viewport; the
 * rest stand behind spacers sized from these numbers. A message's
 * height is measured every frame it is drawn and kept, keyed by the
 * terminal width it was drawn at, so a message that scrolls out keeps
 * its real height instead of falling back to the newline-counting
 * estimate (which does not know about wrapping). A width change makes
 * every kept height stale; those messages fall back to the estimate
 * until they are drawn again.
 *
 * When a measurement differs from what the last frame assumed, one
 * re-render is requested so the spacers and the window follow. Heights
 * that do not change request nothing, so this settles. `quietId` is
 * measured and kept but never requests a render: it is the live block
 * under the messages, which changes on every streamed token, and a
 * frame is already on its way each time it does.
 *
 * `ids` is every id the log holds, memoised on the message list; ids
 * that leave it (a session swap, a cleared chat) are forgotten.
 */
export function useMeasuredRowHeights(
  columns: number,
  ids: readonly string[],
  quietId?: string,
): MeasuredRowHeights {
  const heights = useRef(new Map<string, MeasuredRows>());
  const nodes = useRef(new Map<string, DOMElement>());
  const refs = useRef(new Map<string, (node: DOMElement | null) => void>());
  const [, setVersion] = useState(0);

  useEffect(() => {
    let changed = false;
    for (const [id, node] of nodes.current) {
      const layout = measureElement(node);
      // Zero width means Yoga has not laid the box out yet; a laid-out
      // message in the chat column is always as wide as the column.
      if (layout.width <= 0) continue;
      const rows = Math.max(0, layout.height);
      const known = heights.current.get(id);
      if (known?.columns === columns && known.rows === rows) continue;
      heights.current.set(id, { columns, rows });
      if (id !== quietId) changed = true;
    }
    if (changed) setVersion((v) => v + 1);
  });

  useEffect(() => {
    const live = new Set(ids);
    for (const map of [heights.current, refs.current]) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
  }, [ids]);

  const heightOf = useCallback(
    (id: string, estimate: () => number): number => {
      const known = heights.current.get(id);
      return known?.columns === columns ? known.rows : estimate();
    },
    [columns],
  );

  const refFor = useCallback((id: string) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = (node: DOMElement | null) => {
        if (node) nodes.current.set(id, node);
        else nodes.current.delete(id);
      };
      refs.current.set(id, ref);
    }
    return ref;
  }, []);

  return { heightOf, refFor };
}
