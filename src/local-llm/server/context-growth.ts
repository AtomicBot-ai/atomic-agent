/**
 * A context window that starts small and grows with the conversation, on
 * a GPU with memory of its own.
 *
 * The auto-sized context used to be everything that fits: free VRAM ×
 * 0.92, less the weights and a flat compute allowance, the rest to the KV
 * cache. On a 24 GB card that handed qwen-3.8-27b and gemma-4-12b the
 * model's whole 262,144-token window, and with it eight auto slots
 * (`worker-slots.ts`), and they ran at 5-6 tokens a second where the rest
 * of the catalogue ran at 85-122; a 7.5k-token prompt took 427 s
 * (ATO-848, ATO-867). The likely cause is that the estimate leaves
 * nothing for what grows with the window and the slots outside the
 * cache, so part of the model lands on the CPU.
 *
 * Nobody needs a quarter-million-token window for a conversation that
 * holds eight thousand. So on such a card the auto window starts at
 * {@link GPU_AUTO_START_CONTEXT}; the full fit becomes the ceiling it may
 * grow to, and the daemon's owner restarts it one doubling at a time as
 * the conversation fills the window it has (`decideContextGrowth`).
 *
 * Out of scope on purpose:
 * - Apple silicon and integrated GPUs (unified memory). Their fit is
 *   already held to a share of RAM (`context-size.ts`) and runs at speed.
 * - A pinned `localModels.managed.contextSize` or `parallel`: the
 *   operator's number is the number, uncapped, as before.
 * - CPU-only and multi-GPU launches: no single free-VRAM figure, so the
 *   fit is already the conservative no-VRAM default.
 */

import { MIN_AUTO_CONTEXT } from "./context-size.js";

/**
 * Where the auto window starts on a dedicated GPU: the auto-size floor,
 * 32,768 tokens — the smallest window the agent works in (its ~5.2k
 * stable prefix plus a full reply budget, see `MIN_AUTO_CONTEXT`), and
 * four times the 7.5k-token prompt the slow launches were measured on.
 */
export const GPU_AUTO_START_CONTEXT = MIN_AUTO_CONTEXT;

/**
 * Most request slots `parallel: "auto"` gives a growing launch. The slot
 * count is derived from the window (one per ~32k of pool), so a window
 * grown to 262,144 would bring back the eight slots that went with the
 * slow launches, and every slot costs the device buffers of its own
 * outside the KV estimate (ATO-333). Two keeps one Fusion worker running
 * beside another, or beside the orchestrating stream, which is where
 * concurrency paid in measurements; a pinned `parallel` is not held to it.
 */
export const GPU_AUTO_MAX_SLOTS = 2;

/**
 * Share of the prompt's room (the window less the reply reserve) a
 * conversation may fill before the window is grown. The prompt packer
 * starts dropping old turns at 100% of that room, so growing at three
 * quarters gives the next turn a bigger window before anything is cut.
 */
export const CONTEXT_GROWTH_TRIGGER_SHARE = 0.75;

/**
 * `localModels.managed.contextSize` value that means "the model's own
 * maximum": larger than any trained context, so the existing clamp
 * (`estimateContextSize`: a pinned value never exceeds the model's
 * trained ceiling) turns it into exactly that ceiling for whichever model
 * is loaded. A pinned value, so it is never held to the start window.
 */
export const CONTEXT_SIZE_MODEL_MAX = 1_048_576;

/**
 * The context choices a settings list offers, as stored in
 * `localModels.managed.contextSize`: Auto (`0`), 32K, 64K, 128K, and the
 * model's maximum. Any other non-negative integer stays valid in config.
 */
export const MANAGED_CONTEXT_SIZE_PRESETS: readonly number[] = [
  0,
  32_768,
  65_536,
  131_072,
  CONTEXT_SIZE_MODEL_MAX,
];

/**
 * The request-slot choices a settings list offers, as stored in
 * `localModels.managed.parallel`: Auto, 1, 2, 4. The parser also takes
 * any integer 1..8, and `0` as Auto.
 */
export const MANAGED_PARALLEL_PRESETS: readonly (number | "auto")[] = [
  "auto",
  1,
  2,
  4,
];

function roundDownToKi(value: number): number {
  return Math.floor(value / 1024) * 1024;
}

export interface GrowingAutoContext {
  /** The window this launch starts with. */
  contextSize: number;
  /** The most it may grow to: the full memory fit. */
  ceiling: number;
}

/**
 * The window an auto-sized launch on a dedicated GPU starts with:
 * {@link GPU_AUTO_START_CONTEXT}, or `atLeast` when the owner restarts it
 * to grow, never past `fitContext` (`estimateContextSize`'s answer, which
 * becomes the ceiling).
 */
export function resolveGrowingAutoContext(input: {
  fitContext: number;
  atLeast?: number | null;
}): GrowingAutoContext {
  const fit = Math.max(0, Math.floor(input.fitContext));
  const wanted =
    typeof input.atLeast === "number" && Number.isFinite(input.atLeast)
      ? Math.max(GPU_AUTO_START_CONTEXT, roundDownToKi(input.atLeast))
      : GPU_AUTO_START_CONTEXT;
  return { contextSize: Math.min(fit, wanted), ceiling: fit };
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
