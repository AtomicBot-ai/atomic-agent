/**
 * The auto-sized context on a GPU with memory of its own (Linux/Windows
 * cards), and the window that grows with the conversation.
 *
 * The auto-sized context used to be everything that fits: free VRAM ×
 * 0.92, less the weights and a flat compute allowance, the rest to the KV
 * cache. On a 24 GB card that handed qwen-3.8-27b and gemma-4-12b the
 * model's whole 262,144-token window, and with it eight auto slots
 * (`worker-slots.ts`), and they ran at 5-6 tokens a second where the rest
 * of the catalogue ran at 85-122; a 7.5k-token prompt took 427 s
 * (ATO-848, ATO-867). The likely cause is that the estimate leaves
 * nothing for what grows with the window and the slots outside the
 * cache, so part of the model lands on the CPU. Correcting the fit itself
 * is ATO-866 / ATO-333; until then the auto window on such a card is held
 * here in two ways:
 *
 * - **Every auto launch**: at most {@link GPU_AUTO_MAX_CONTEXT} tokens and
 *   {@link GPU_AUTO_MAX_SLOTS} auto slots.
 * - **A growable launch** — only when the daemon's owner can grow it (the
 *   TUI on a plain local chat route passes `growContext`): the window
 *   starts at {@link GPU_AUTO_START_CONTEXT} with at most
 *   {@link GPU_GROWING_MAX_SLOTS} slots, and the owner restarts it one
 *   doubling at a time, up to the same cap, as the conversation fills it
 *   (`decideContextGrowth`). A launch nobody grows (the desktop, the CLI,
 *   Fusion) must not be stuck at the start window, so it is never small.
 *
 * Out of scope on purpose: Apple silicon and integrated GPUs (unified
 * memory, already held to a share of RAM in `context-size.ts`); a pinned
 * `localModels.managed.contextSize` or `parallel` (the operator's number,
 * uncapped); CPU-only and multi-GPU launches (no single free-VRAM figure).
 */

import { MIN_AUTO_CONTEXT } from "./context-size.js";

/**
 * Most tokens an auto window takes on a GPU with memory of its own: half
 * the trained 262,144 that the slow launches had. A conversation that
 * needs more pins `localModels.managed.contextSize`.
 */
export const GPU_AUTO_MAX_CONTEXT = 131_072;

/**
 * Most auto request slots on such a card. 131,072 holds four ~32k worker
 * footprints, so Fusion's local workers keep four at once; the eight the
 * uncapped window derived each cost device buffers outside the estimate
 * (ATO-333). A pinned `parallel` is not held to it.
 */
export const GPU_AUTO_MAX_SLOTS = 4;

/**
 * Where a growable window starts: the auto-size floor, 32,768 tokens —
 * the smallest window the agent works in (its ~5.2k stable prefix plus a
 * full reply budget, see `MIN_AUTO_CONTEXT`), and four times the
 * 7.5k-token prompt the slow launches were measured on.
 */
export const GPU_AUTO_START_CONTEXT = MIN_AUTO_CONTEXT;

/**
 * Most auto slots on a growable launch. Growth serves one conversation;
 * two keeps a second stream (a reflection or naming sub-call) from
 * queueing behind it without spending the small window on slots.
 */
export const GPU_GROWING_MAX_SLOTS = 2;

/**
 * Share of the prompt's room (the window less the reply reserve) a
 * conversation may fill before the window is grown. The prompt packer
 * starts dropping old turns at 100% of that room, so growing at three
 * quarters gives the next turn a bigger window before anything is cut.
 */
export const CONTEXT_GROWTH_TRIGGER_SHARE = 0.75;

/**
 * `localModels.managed.contextSize` value that means "the model's own
 * maximum" (the ATO-336 settings choice): larger than any trained
 * context, so the existing clamp (`estimateContextSize`: a pinned value
 * never exceeds the model's trained ceiling) turns it into exactly that
 * ceiling for whichever model is loaded. A pinned value, never capped.
 */
export const CONTEXT_SIZE_MODEL_MAX = 1_048_576;

function roundDownToKi(value: number): number {
  return Math.floor(value / 1024) * 1024;
}

export interface DedicatedGpuAutoContext {
  /** The window this launch starts with. */
  contextSize: number;
  /** How far it may grow; `null` for a launch nobody grows. */
  ceiling: number | null;
  /** The most auto request slots this launch gets. */
  maxSlots: number;
}

/**
 * The auto window on a GPU with memory of its own, from
 * `estimateContextSize`'s fit. Not growable: the fit, at most
 * {@link GPU_AUTO_MAX_CONTEXT}. Growable: {@link GPU_AUTO_START_CONTEXT},
 * or `atLeast` when the owner restarts it to grow, with that same capped
 * fit as the ceiling.
 */
export function resolveDedicatedGpuAutoContext(input: {
  fitContext: number;
  growable: boolean;
  atLeast?: number | null;
}): DedicatedGpuAutoContext {
  const capped = Math.min(
    Math.max(0, Math.floor(input.fitContext)),
    GPU_AUTO_MAX_CONTEXT,
  );
  if (!input.growable) {
    return { contextSize: capped, ceiling: null, maxSlots: GPU_AUTO_MAX_SLOTS };
  }
  const wanted =
    typeof input.atLeast === "number" && Number.isFinite(input.atLeast)
      ? Math.max(GPU_AUTO_START_CONTEXT, roundDownToKi(input.atLeast))
      : GPU_AUTO_START_CONTEXT;
  return {
    contextSize: Math.min(capped, wanted),
    ceiling: capped,
    maxSlots: GPU_GROWING_MAX_SLOTS,
  };
}

export interface ContextGrowthInput {
  /** The window the running daemon has (`LaunchRecord.contextSize`). */
  currentContext: number;
  /**
   * How far it may grow (`LaunchRecord.autoContextCeiling`); `null` for a
   * launch that does not grow (pinned, unified memory, CPU).
   */
  ceiling: number | null | undefined;
  /** Tokens in the conversation's last prompt, as the server counted them. */
  promptTokens: number;
  /**
   * The reply reservation the prompt budget holds back on this window —
   * `effectiveReplyReserve(completionMaxTokens, currentContext)` from
   * `src/prompt/token-budget.ts`, passed in because this layer does not
   * import the prompt builder.
   */
  replyReserveTokens: number;
}

/**
 * The window to restart the daemon with before the next turn, or `null`
 * to keep the one it has. One doubling per call, held to the ceiling:
 * the caller restarts at most once per turn, so a conversation that has
 * outgrown several steps climbs one per turn rather than being reloaded
 * several times in a row.
 */
export function decideContextGrowth(input: ContextGrowthInput): number | null {
  const current = input.currentContext;
  const ceiling = input.ceiling;
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) return null;
  if (!(current > 0) || current >= ceiling) return null;
  if (!(input.promptTokens > 0)) return null;
  const reserve = Math.max(0, input.replyReserveTokens || 0);
  const room = Math.max(1, current - reserve);
  if (input.promptTokens <= room * CONTEXT_GROWTH_TRIGGER_SHARE) return null;
  const next = Math.min(roundDownToKi(ceiling), current * 2);
  return next > current ? next : null;
}
