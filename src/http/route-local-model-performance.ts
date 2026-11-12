import { getConfig } from "../config/index.js";
import {
  activeTextProviderIsLlamaServer,
  resolveLlmConfig,
} from "../llm/provider/registry/index.js";
import { PERFORMANCE_CAPACITY } from "../llm/llama-performance-samples.js";
import { readSlotOccupancy } from "../tools/fusion/worker-result.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/** How long the route waits for the local server's `/slots`. */
export const PERFORMANCE_SLOTS_TIMEOUT_MS = 1500;

export interface PerformanceSlots {
  total: number;
  busy: number;
  /** The first slot's `n_ctx`; `null` when the server does not report it. */
  contextPerSlot: number | null;
}

/**
 * `GET /api/local-model/performance` — the desktop's Performance pane
 * (issue #996). Answers
 *
 *   `{ local, url, capacity, samples, slots }`
 *
 * `samples` are the local model server's recent completed requests,
 * oldest first: speeds, token counts, first-token wait and how many
 * requests shared the server, never any prompt or reply text. `local`
 * says whether the running agent's chat goes to llama-server at all; it
 * and `url` come from the cached config the live turns read, which
 * `POST /api/llm/active` resets. Only when `local` is true does the route
 * ask the server's `/slots` (once, bounded at 1.5 s) for the live load
 * and the context per slot; any failure there is `slots: null`, never an
 * error status. Writes nothing. Behind the API key like every `/api`
 * route.
 */
export function createLocalModelPerformanceHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const config = getConfig();
    const local = activeTextProviderIsLlamaServer(resolveLlmConfig(config));
    const source = ctx.runtime.localPerformance?.() ?? null;
    const slots = local && source !== null ? await readSlots(source.fetchSlots) : null;
    sendJson(res, 200, {
      local,
      url: config.localModels.url,
      capacity: source?.capacity ?? PERFORMANCE_CAPACITY,
      samples: source?.samples ?? [],
      slots,
    });
  };
}

async function readSlots(
  fetchSlots: (timeoutMs: number) => Promise<unknown>,
): Promise<PerformanceSlots | null> {
  let body: unknown;
  try {
    body = await fetchSlots(PERFORMANCE_SLOTS_TIMEOUT_MS);
  } catch {
    return null;
  }
  return slotsFromBody(body);
}

/** The slot table's load and context size, or `null` when it is not a slot table. */
export function slotsFromBody(body: unknown): PerformanceSlots | null {
  const occupancy = readSlotOccupancy(body);
  if (occupancy === null || !Array.isArray(body)) return null;
  const first = body.find(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
  );
  const nCtx = first?.n_ctx;
  return {
    total: occupancy.total,
    busy: occupancy.busy,
    contextPerSlot:
      typeof nCtx === "number" && Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null,
  };
}
