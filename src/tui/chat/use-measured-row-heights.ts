import { measureElement, type DOMElement } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What a row's height was measured under. `columns` is the terminal
 * width (text wraps differently at another); `render` is everything
 * else that can change a drawn message's rows without changing its id,
 * such as its fold or its expanded tool cards (see `chatRowSignature`).
 */
export interface RowSignature {
  readonly columns: number;
  readonly render: string;
}

interface MeasuredRows extends RowSignature {
  readonly rows: number;
}

export interface MeasuredRowHeights {
  /**
   * Measured rows of `id` under its current signature, or `estimate()`
   * when there is none. The estimate is a thunk so a long history does
   * not re-count every message's lines on every frame.
   */
  heightOf(id: string, estimate: () => number): number;
  /**
   * True when `id` was measured at the current width but under another
   * render signature: "expand all" or a fold changed it while it was off
   * screen. The log draws such a message once so its rows are measured
   * again; see `widenChatWindow`.
   */
  needsRedraw(id: string): boolean;
  /** Stable ref callback for the box that wraps `id`. */
  refFor(id: string): (node: DOMElement | null) => void;
}

/**
 * Remembers how many rows each drawn chat message really took (ATO-650).
 *
 * The windowed log only lays out the messages near the viewport; the
 * rest stand behind spacers sized from these numbers. A message's
 * height is measured every frame it is drawn and kept, tagged with the
 * signature it was drawn under (`signatureOf`), so a message that
 * scrolls out keeps its real height instead of falling back to the
 * newline-counting estimate (which does not know about wrapping).
 *
 * A kept height counts only under the signature it was measured with.
 * After a width change every kept height is stale; those messages fall
 * back to the estimate until they are drawn again (a resize repaints
 * many frames, and redrawing the whole history on each would undo the
 * windowing). After a render change at the same width, such as "expand
 * all", the estimate would still be the collapsed size, so
 * `needsRedraw` asks for the message to be drawn once and measured.
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
  ids: readonly string[],
  signatureOf: (id: string) => RowSignature,
  quietId?: string,
): MeasuredRowHeights {
  // The effect below measures what the last commit drew, so it tags the
  // rows with that render's signatures, not a later one's.
  const latestSignatureOf = useRef(signatureOf);
  latestSignatureOf.current = signatureOf;
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
      const { columns, render } = latestSignatureOf.current(id);
      const known = heights.current.get(id);
      if (
        known?.columns === columns &&
        known.render === render &&
        known.rows === rows
      ) {
        continue;
      }
      heights.current.set(id, { columns, render, rows });
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
      if (known === undefined) return estimate();
      const now = signatureOf(id);
      return known.columns === now.columns && known.render === now.render
        ? known.rows
        : estimate();
    },
    [signatureOf],
  );

  const needsRedraw = useCallback(
    (id: string): boolean => {
      const known = heights.current.get(id);
      if (known === undefined) return false;
      const now = signatureOf(id);
      return known.columns === now.columns && known.render !== now.render;
    },
    [signatureOf],
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

  return { heightOf, needsRedraw, refFor };
}
