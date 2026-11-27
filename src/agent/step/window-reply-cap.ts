/**
 * Keep a local reply's cap inside the window it runs in (ATO-1581).
 *
 * The budget holds back a reply reserve (`effectiveReplyReserve`), not
 * `n_predict`: on a 32K window the reserve is 8,192 while the shipped
 * cap, `localModels.completionMaxTokens`, is 16,384. When the prompt
 * fills the rest, a long reply would run into the window wall and come
 * back cut mid-stream (`truncated` without a `length` stop), which the
 * failure detector reads as the window, not the cap. Sending a cap that
 * fits the room instead makes the same long reply stop cleanly at the
 * cap, which the truncation retry already knows how to handle.
 *
 * Only for a local grammar link (the one that reads `localReplyCap`),
 * only when the step names no cap of its own (a truncation retry, a
 * fusion worker's ceiling), only for a positive configured cap (`0` is
 * "no cap", llama.cpp's `-1`), and only when the window and the prompt
 * estimate are both known. It never raises a cap.
 */

/** Room kept between the cap and a known window, for token-estimate drift. */
export const WINDOW_REPLY_HEADROOM_TOKENS = 512;

export interface WindowReplyCapInput {
  /** The step's model mode; legacy wiring without one reads as `local`. */
  modelMode: "local" | "cloud";
  /** The step's configured transport. Only a grammar link is a local llama-server. */
  toolTransport: "grammar" | "native_tools";
  /** `localModels.completionMaxTokens` as resolved (env included). */
  configuredCap: number;
  /** The step carries its own cap (`maxTokens` / `maxOutputTokens`). */
  stepCapSet: boolean;
  /** The window the runtime believes in, when it knows one. */
  contextWindow: number | null;
  /** The prompt's token estimate. */
  promptTokens: number;
}

/**
 * The cap that fits the room the prompt leaves, or `null` when the
 * configured cap already fits (or nothing is known to clamp against).
 */
export function windowReplyCap(input: WindowReplyCapInput): number | null {
  if (input.stepCapSet) return null;
  if (input.modelMode === "cloud") return null;
  if (input.toolTransport !== "grammar") return null;
  if (input.configuredCap <= 0) return null;
  if (input.contextWindow === null || input.contextWindow <= 0) return null;
  if (input.promptTokens <= 0) return null;
  const room = Math.floor(
    input.contextWindow - input.promptTokens - WINDOW_REPLY_HEADROOM_TOKENS,
  );
  // No room at all is a prompt that does not fit: the overflow path owns it.
  if (room <= 0) return null;
  return room < input.configuredCap ? room : null;
}
