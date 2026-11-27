import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * Local-first cascade for a normal chat turn (ATO-2208).
 *
 * The configured chain runs cloud first: the active provider heads it
 * and a local link, if any, sits at the tail (`appendLocal`). With
 * `llm.fallback.localFirst` on, a turn whose active provider is a cloud
 * one starts on the configured local (`llama-server`) provider instead,
 * and when that link fails the way any primary falls over
 * (`shouldAdvance`: unreachable, 5xx, a defective completion) the same
 * turn goes on on the active cloud provider and the rest of the chain.
 * The caller puts the answer first in the session's chain for the turn
 * (`ProviderFallbackChain.setTurnPrimary`), the seam the model router
 * already uses, so the switch is announced like every fallover
 * (`provider_switched`) and the daily spend ceiling still guards the
 * cloud link.
 *
 * Precedent: an ordered model fallback list (OpenRouter `models`,
 * LiteLLM `fallbacks`) with the cheap model first, as in FrugalGPT.
 *
 * It stays out of the way of every other way the provider is chosen:
 *  - off unless `localFirst` is true (default false);
 *  - nothing under Fusion (it owns the choice of provider) or when the
 *    active provider is already local (the chain already starts there;
 *    a cloud link in `fallback.chain` is the cascade);
 *  - nothing for a turn that is already pinned (a Fusion worker, a
 *    caller's explicit `providerId`);
 *  - nothing when no local link can serve the turn: not built, no model
 *    on disk (`isUnavailable`), or it says it cannot do tools, or the
 *    message carries an image and it says it cannot see one;
 *  - nothing when the session is already too long for the local window
 *    (`too-long`, ATO-2537): the prompt and compaction are sized to the
 *    turn's head, so a long cloud session started on a small local
 *    window would be compacted down to it, and that cut is written to
 *    the session even when the turn then goes on in the cloud;
 *  - nothing while the local link rests after it failed as a turn head
 *    (`cooling-down`, ATO-2435, `turn-head-cooldown.ts`): a local server
 *    that hangs until the timeout would cost that wait on every turn.
 *
 * Pure: the caller supplies every fact.
 */

export interface LocalFirstProvider {
  id: string;
  /** A `llama-server` provider: on this machine. */
  local?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface LocalFirstInput {
  /** `llm.fallback.localFirst`. */
  localFirst: boolean | undefined;
  /** The run mode the turn actually runs under. */
  effectiveRunMode: RunModeName;
  activeProviderId: string;
  /** Set when the caller already pinned the turn. */
  pinnedProviderId?: string;
  /** Configured providers, in config order. */
  providers: readonly LocalFirstProvider[];
  /** Whether the turn's message carries an image. */
  hasImage: boolean;
  /** Whether the provider registry built this provider. */
  isRegistered: (providerId: string) => boolean;
  /** Whether this link cannot serve here now (no model downloaded). */
  isUnavailable: (providerId: string) => boolean;
  /**
   * Whether the session's next prompt would trigger compaction on this
   * link's window (ATO-2537; the caller sizes it, see
   * `runtime/composition/local-first-fit.ts`). Absent: never.
   */
  tooLongFor?: (providerId: string) => boolean;
  /** Whether this link failed as a turn head recently and still rests. */
  isCoolingDown?: (providerId: string) => boolean;
}

export type LocalFirstDecision =
  | { head: string }
  | {
      head: null;
      reason: "off" | "fusion" | "pinned" | "active-local" | "no-local" | "cooling-down" | "too-long";
    };

export function localFirstTurnHead(input: LocalFirstInput): LocalFirstDecision {
  if (input.localFirst !== true) return { head: null, reason: "off" };
  if (input.effectiveRunMode === "fusion") return { head: null, reason: "fusion" };
  if (input.pinnedProviderId !== undefined) return { head: null, reason: "pinned" };
  const active = input.providers.find((p) => p.id === input.activeProviderId);
  if (active === undefined || active.local === true || input.effectiveRunMode === "local") {
    return { head: null, reason: "active-local" };
  }
  const usable = input.providers.filter(
    (p) =>
      p.local === true &&
      input.isRegistered(p.id) &&
      !input.isUnavailable(p.id) &&
      p.supportsTools !== false &&
      !(input.hasImage && p.supportsVision === false),
  );
  if (usable.length === 0) return { head: null, reason: "no-local" };
  const rested = usable.filter((p) => input.isCoolingDown?.(p.id) !== true);
  if (rested.length === 0) return { head: null, reason: "cooling-down" };
  const local = rested.find((p) => fitsLocalWindow(input, p.id));
  if (local === undefined) return { head: null, reason: "too-long" };
  return { head: local.id };
}

/** Whether the session fits this link's window (no size check: yes). */
function fitsLocalWindow(input: LocalFirstInput, providerId: string): boolean {
  return input.tooLongFor?.(providerId) !== true;
}
