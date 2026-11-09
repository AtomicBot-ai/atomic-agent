/**
 * The safety net under the auto-sized window (ATO-868). The fit in
 * `context-size.ts` is an estimate; when it is wrong on the high side,
 * llama.cpp's `-fit` does not fail, it quietly leaves some of the model's
 * layers on the CPU and the model decodes at a fraction of its speed with
 * no sign of why. llama.cpp says so in its load log
 * (`load_tensors: offloaded N/M layers to GPU`), so `startDaemon` reads
 * that line once the server is up and, when the window was auto-sized,
 * restarts it once with half the window. The pieces here are pure.
 */

import { MIN_AUTO_CONTEXT } from "./context-size.js";

/** How many of the model's layers llama.cpp put on the GPU, from its load log. */
export interface GpuOffload {
  offloaded: number;
  total: number;
}

/**
 * The last `offloaded N/M layers to GPU` line in a log (llama.cpp's
 * `load_tensors` report), or `null` when the log has none. Pure.
 */
export function parseGpuOffload(logText: string): GpuOffload | null {
  let last: GpuOffload | null = null;
  for (const match of logText.matchAll(/offloaded (\d+)\/(\d+) layers to GPU/g)) {
    const offloaded = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isFinite(offloaded) && Number.isFinite(total) && total > 0) {
      last = { offloaded, total };
    }
  }
  return last;
}

/** The one restart `startDaemon` makes after a partial offload (ATO-868). */
export interface PartialOffloadShrink {
  from: number;
  to: number;
  offloaded: number;
  total: number;
}

/**
 * Whether a launch that just came up should be restarted once with half
 * its window because llama.cpp left some of the model's layers on the CPU
 * (ATO-868): the window was auto-sized (a pinned `contextSize` is the
 * operator's number and stays), the device is not the CPU, the log shows
 * fewer layers on the GPU than the model has, this is not already the
 * retry, and halving (never below `MIN_AUTO_CONTEXT`) makes it smaller.
 * The slot count follows the new window by itself (`parallel: "auto"`
 * derives it from the context; a pinned `parallel` stays). Pure.
 */
export function decidePartialOffloadShrink(input: {
  configuredContextSize: number;
  device: string | undefined;
  contextSize: number;
  offload: GpuOffload | null;
  alreadyRetried: boolean;
}): PartialOffloadShrink | null {
  if (input.alreadyRetried) return null;
  if (input.configuredContextSize > 0) return null;
  if (input.device === "cpu") return null;
  const offload = input.offload;
  if (!offload || offload.offloaded >= offload.total) return null;
  const from = input.contextSize;
  if (!(from > MIN_AUTO_CONTEXT)) return null;
  const to = Math.max(MIN_AUTO_CONTEXT, Math.floor(from / 2 / 1024) * 1024);
  if (to >= from) return null;
  return { from, to, offloaded: offload.offloaded, total: offload.total };
}
