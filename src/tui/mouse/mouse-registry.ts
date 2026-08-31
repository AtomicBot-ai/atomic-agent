/**
 * Hit-testing registry: turns a screen coordinate into the component
 * that owns that cell.
 *
 * Ink exposes no absolute positions — `measureElement` returns a size
 * only — but every rendered node keeps its Yoga node, and Yoga computes
 * each box's offset relative to its parent's border box. Ink's own
 * renderer walks the tree the same way (`render-node-to-output.ts`
 * accumulates `offsetX/offsetY` from `getComputedLeft/Top`), so summing
 * the chain up to the root reproduces exactly the cell the renderer
 * painted the node into. That equivalence is what makes clicking
 * reliable instead of a table of hardcoded row numbers that rots the
 * next time a panel gains a header line.
 *
 * Targets register a ref plus a handler; a click is offered to the
 * candidates whose rectangle contains the point, innermost first, until
 * one claims it. `minLayer` is the modal gate: while a modal owns the
 * keyboard, only targets registered at the modal layer are eligible, so
 * a click cannot reach the list rendered behind it.
 */
import type { DOMElement } from "ink";
import type { RefObject } from "react";
import type { TuiMouseEvent } from "./mouse-event.js";

/** Chat log, status bar, sidebar, prompt — the resting UI. */
export const MOUSE_LAYER_BASE = 0;
/** Observe / Manage panel bodies. */
export const MOUSE_LAYER_PANEL = 1;
/** Modals, confirms and pickers — claim clicks exclusively while open. */
export const MOUSE_LAYER_MODAL = 2;
/**
 * The right-click cut/copy/paste menu. Above MODAL because it can open
 * on top of a modal's own text field (the approval path, the MCP JSON
 * editor), and on its OWN rung rather than joining `modalOwnsInput`
 * deliberately: joining would collapse the composer to one line
 * (`composerMaxEditorLines`), which shifts the very cell the menu is
 * anchored to out from under it.
 */
export const MOUSE_LAYER_CONTEXT_MENU = 3;

export interface MouseRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MouseHit {
  readonly event: TuiMouseEvent;
  /** Click column relative to the target's left edge. */
  readonly localX: number;
  /** Click row relative to the target's top edge. */
  readonly localY: number;
  readonly rect: MouseRect;
}

/** Return `true` to claim the event; `false` lets it fall through. */
export type MouseTargetHandler = (hit: MouseHit) => boolean;

export interface MouseTargetOptions {
  readonly ref: RefObject<DOMElement | null>;
  readonly handler: MouseTargetHandler;
  readonly layer?: number;
}

interface RegisteredTarget extends MouseTargetOptions {
  readonly id: number;
  readonly layer: number;
}

export class MouseTargetRegistry {
  private readonly targets = new Map<number, RegisteredTarget>();
  private nextId = 1;
  private minLayer = MOUSE_LAYER_BASE;
  /**
   * The target holding the pointer for the duration of a drag, if any.
   *
   * Hit-testing by position is right for clicks and wrong for drags: a
   * selection that starts in the composer and travels up into the chat
   * log would otherwise deliver its motion — and its terminating
   * release — to whatever sits under the cursor, so the selection would
   * stop extending and never end. While captured, every event goes to
   * the capturing target and to nobody else.
   */
  private captured: RegisteredTarget | null = null;

  /** Registers a target and returns its unregister function. */
  register(options: MouseTargetOptions): () => void {
    const id = this.nextId++;
    this.targets.set(id, {
      ...options,
      id,
      layer: options.layer ?? MOUSE_LAYER_BASE,
    });
    return () => {
      this.targets.delete(id);
    };
  }

  /**
   * Raises the floor for eligible targets. Set to `MOUSE_LAYER_MODAL`
   * while a modal is open so background surfaces stop responding.
   */
  setMinLayer(layer: number): void {
    this.minLayer = layer;
    // A modal opening mid-drag ends the drag: the surface underneath is
    // no longer eligible, and a capture that outlived it would keep
    // feeding it events from behind the modal.
    if (this.captured && this.captured.layer < layer) this.captured = null;
  }

  /**
   * Route every event to `target` until {@link releasePointer}. Called
   * by a target from inside its own press handler.
   */
  capturePointer(ref: RefObject<DOMElement | null>): void {
    for (const target of this.targets.values()) {
      if (target.ref === ref) {
        this.captured = target;
        return;
      }
    }
  }

  /** Hand routing back to hit-testing. Safe to call when nothing is captured. */
  releasePointer(): void {
    this.captured = null;
  }

  /**
   * Offers `event` to the matching targets; `true` when one claimed it
   * or a captured pointer took it. `false` means the event landed on
   * dead content — the signal `drag-intent.ts` builds selection
   * detection on.
   */
  dispatch(event: TuiMouseEvent): boolean {
    const captured = this.captured;
    if (captured) {
      // A captured target that has unmounted (or whose layer is now
      // below the floor) cannot receive anything — drop the capture
      // rather than swallow every event for the rest of the session.
      const rect = absoluteRect(captured.ref.current);
      if (!rect || captured.layer < this.minLayer) {
        this.captured = null;
      } else {
        captured.handler({
          event,
          localX: event.x - rect.left,
          localY: event.y - rect.top,
          rect,
        });
        // Consumed regardless of what the handler said: while captured
        // the event was routed exclusively and never offered to anyone
        // else, so from the pipeline's point of view a live target took
        // it — a drag mid-capture must not read as a selection intent.
        return true;
      }
    }
    const hits: Array<{ target: RegisteredTarget; rect: MouseRect }> = [];
    for (const target of this.targets.values()) {
      if (target.layer < this.minLayer) continue;
      const rect = absoluteRect(target.ref.current);
      if (!rect || !containsPoint(rect, event.x, event.y)) continue;
      hits.push({ target, rect });
    }
    // Innermost wins: higher layer first, then the smaller box, then the
    // more recently mounted node (later siblings paint over earlier ones).
    hits.sort(
      (a, b) =>
        b.target.layer - a.target.layer ||
        area(a.rect) - area(b.rect) ||
        b.target.id - a.target.id,
    );
    for (const hit of hits) {
      const claimed = hit.target.handler({
        event,
        localX: event.x - hit.rect.left,
        localY: event.y - hit.rect.top,
        rect: hit.rect,
      });
      if (claimed) return true;
    }
    return false;
  }
}

/**
 * Absolute screen rectangle of `node`, in terminal cells, or `null`
 * when the node is unmounted or has not been through a layout pass.
 * Ancestors that clip (`overflow: hidden`) trim the result, so a chat
 * row scrolled out of the viewport is not clickable where it would
 * have been painted.
 */
export function absoluteRect(node: DOMElement | null): MouseRect | null {
  const yoga = node?.yogaNode;
  if (!node || !yoga) return null;
  const own = yoga.getComputedLayout();
  // `rect` is always expressed in the coordinate space of the ancestor
  // currently being visited, then translated one level up per step.
  let rect: MouseRect = {
    left: own.left,
    top: own.top,
    width: own.width,
    height: own.height,
  };
  let parent = node.parentNode;
  while (parent?.yogaNode) {
    const layout = parent.yogaNode.getComputedLayout();
    if (clipsOverflow(parent)) {
      const clipped = intersect(rect, {
        left: 0,
        top: 0,
        width: layout.width,
        height: layout.height,
      });
      if (!clipped) return null;
      rect = clipped;
    }
    rect = {
      ...rect,
      left: rect.left + layout.left,
      top: rect.top + layout.top,
    };
    parent = parent.parentNode;
  }
  return rect;
}

function clipsOverflow(node: DOMElement): boolean {
  const style = node.style as { overflowX?: string; overflowY?: string };
  return style.overflowX === "hidden" || style.overflowY === "hidden";
}

function intersect(a: MouseRect, b: MouseRect): MouseRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function containsPoint(rect: MouseRect, x: number, y: number): boolean {
  return (
    x >= rect.left &&
    x < rect.left + rect.width &&
    y >= rect.top &&
    y < rect.top + rect.height
  );
}

function area(rect: MouseRect): number {
  return rect.width * rect.height;
}
