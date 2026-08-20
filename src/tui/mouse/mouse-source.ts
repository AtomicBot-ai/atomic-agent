import type { TuiMouseEvent } from "./mouse-event.js";

/** Read side of the mouse pipe, handed to `TuiApp` as a prop. */
export interface MouseSource {
  subscribe(listener: (event: TuiMouseEvent) => void): () => void;
}

export interface MouseSourceEmitter extends MouseSource {
  emit(event: TuiMouseEvent): void;
}

/**
 * Tiny pub/sub bridging the stdin decoder (plain Node, outside React)
 * to the Ink tree — the same shape as `makeTuiEventBus`, for the same
 * reason: the app shell subscribes, the process-level plumbing emits,
 * and tests can drive clicks without a terminal.
 */
export function makeMouseSource(): MouseSourceEmitter {
  const listeners = new Set<(event: TuiMouseEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}
