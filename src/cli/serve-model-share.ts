import { createModelShareListener, type ModelShareListener } from "../http/model-share-listener.js";
import { readModelShareSettings } from "../http/model-share-settings.js";
import { createRawModelHandlers, type RawModelHandlers } from "../http/route-raw-model.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

/**
 * ATO-2483: serve's half of the shared model's own listener
 * (http/model-share-listener.ts). One set of raw handlers for both the
 * main listener and the share listener; the listener opens as the config
 * file says once serve listens, and follows the file every few seconds,
 * so `atomic-agent models share --network` in a terminal reaches a serve
 * the desktop started. `POST /api/model-share` applies a change at once.
 */

export const MODEL_SHARE_SYNC_MS = 5_000;

export interface ServeModelShare {
  rawModel: RawModelHandlers;
  listener: ModelShareListener;
  /** Once serve's main listener is up: open the share listener as the file says, then follow the file. */
  attach: (main: { host: string; port: number }) => Promise<void>;
  stop: () => Promise<void>;
}

export function createServeModelShare(runtime: AgentRuntime, syncMs: number = MODEL_SHARE_SYNC_MS): ServeModelShare {
  const rawModel = createRawModelHandlers();
  let main: { host: string; port: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listener = createModelShareListener({ runtime, rawModel, main: () => main });
  return {
    rawModel,
    listener,
    attach: async (address) => {
      main = address;
      await listener.apply(readModelShareSettings());
      timer = setInterval(() => void listener.apply(readModelShareSettings(), { retry: false }), syncMs);
      timer.unref?.();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await listener.close();
    },
  };
}
