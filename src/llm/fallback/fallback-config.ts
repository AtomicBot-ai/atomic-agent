import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";

/**
 * Resolved, defaulted timing knobs for the circuit breaker. All values
 * are wall-clock milliseconds. Defaults are the owner-approved numbers
 * (see AGENTS.md §"Provider fallback chain"); operators override any of
 * them via `llm.fallback.*` but the shape here is always fully
 * populated so the breaker never branches on `undefined`.
 */
export interface FallbackTiming {
  /** Consecutive advance-worthy failures before switching (non-immediate signals). */
  failureThreshold: number;
  /** Escalating cooldown ladder in ms; the last entry is the cap. */
  cooldownMs: readonly number[];
  /** Minimum gap between two primary probes, in ms. */
  probeThrottleMs: number;
  /** No-error window after which the failure counter + cooldown step reset, in ms. */
  failureWindowMs: number;
}

export const DEFAULT_FALLBACK_TIMING: FallbackTiming = {
  failureThreshold: 3,
  cooldownMs: [30_000, 60_000, 300_000],
  probeThrottleMs: 300_000,
  failureWindowMs: 86_400_000,
};

/**
 * The fully resolved fallback plan the chain runs against: an ordered
 * list of configured provider ids (primary first) plus the breaker
 * timing. An ordered chain of length 1 means "no fallback configured" —
 * the chain wrapper then degrades to a transparent pass-through.
 */
export interface ResolvedFallbackChain {
  /** Ordered provider ids, primary (== activeTextProvider) first. */
  chain: readonly string[];
  timing: FallbackTiming;
}

const LOCAL_KIND = "llama-server";

/**
 * Which side of the local/cloud divide a provider sits on.
 *
 * Only `llama-server` is local — it is the one kind that runs the weights
 * in this process's own child. Everything else, `subscription-cli`
 * included, is a remote service: driving a vendor CLI still ships the
 * prompt to that vendor's frontier model over the network, so it belongs
 * with the cloud providers even though the transport is a subprocess.
 */
type ProviderClass = "local" | "cloud";

function providerClass(kind: string | undefined): ProviderClass {
  return kind === LOCAL_KIND ? "local" : "cloud";
}

/**
 * Build the effective fallback chain from resolved LLM config.
 *
 * Rules (AGENTS.md §"Provider fallback chain"):
 *  - Start from `fallback.chain` if present, else `[activeTextProvider]`.
 *  - Drop ids that are not configured providers (defensive — parse-time
 *    validation already rejects unknown ids, but a hot-swapped config
 *    could momentarily disagree).
 *  - Reorder so `activeTextProvider` is the head: the active provider is
 *    the single source of truth for "primary", so a user hot-swapping the
 *    active provider re-primes the chain without editing `fallback.chain`.
 *  - When `appendLocal` (default true), append the configured
 *    llama-server provider id to the tail if it is not already present.
 *    When no local provider is configured, append nothing.
 *  - De-duplicate while preserving first-seen order.
 *  - **Fail over within the primary's own class first.** After the head,
 *    the rest of the chain is grouped: providers of the same class as the
 *    primary, then the others.
 *
 * ### Why the class grouping
 *
 * A fallback is a substitution, and substitutions are not equal. Dropping
 * from a paid frontier cloud model to a 4-bit local one changes far more
 * than availability: context window, tool-calling fidelity, instruction
 * following, and the shape of the answers the user has been reading all
 * session. Moving to *another* cloud provider changes almost none of
 * that. So the chain should exhaust the near substitutes before it
 * reaches for the far one — the local model is the backstop that keeps
 * the agent alive when the network is gone, not the first thing to try
 * when one vendor returns a 500.
 *
 * The rule is symmetric. A deployment whose primary is local has chosen
 * local on purpose (offline, privacy, cost); its first fallback should be
 * another local provider if one is configured, and only then a cloud
 * service that sends the prompt off the machine.
 *
 * Grouping is a **stable partition**, never a sort: an explicit
 * `fallback.chain` is a stated operator preference, so the relative order
 * the operator wrote survives inside each class. `appendLocal` keeps its
 * meaning too — the auto-appended local provider is still appended, it
 * just lands in the local group, which for a cloud primary is the tail
 * exactly as before.
 */
export function resolveFallbackChain(
  resolved: ResolvedLlmConfig,
): ResolvedFallbackChain {
  const configuredIds = new Set(resolved.providers.map((p) => p.id));
  const fallback = resolved.fallback;

  const requested =
    fallback?.chain && fallback.chain.length > 0
      ? fallback.chain
      : [resolved.activeTextProvider];

  // Keep only ids that map to a real provider.
  const filtered = requested.filter((id) => configuredIds.has(id));

  // The active text provider is always the primary. If it is already in
  // the list, hoist it to the front; otherwise prepend it.
  const withPrimary =
    filtered[0] === resolved.activeTextProvider
      ? filtered
      : [
          resolved.activeTextProvider,
          ...filtered.filter((id) => id !== resolved.activeTextProvider),
        ];

  const appendLocal = fallback?.appendLocal ?? true;
  const chain = [...withPrimary];
  if (appendLocal) {
    const localId = resolved.providers.find((p) => p.kind === LOCAL_KIND)?.id;
    if (localId && !chain.includes(localId)) {
      chain.push(localId);
    }
  }

  return {
    chain: groupByPrimaryClass(
      dedupe(chain.filter((id) => configuredIds.has(id))),
      resolved.providers,
    ),
    timing: resolveTiming(fallback),
  };
}

/**
 * Keep the head where it is and stable-partition the tail so the
 * primary's own class comes first. See the class-grouping rationale on
 * `resolveFallbackChain`.
 */
function groupByPrimaryClass(
  ids: readonly string[],
  providers: ResolvedLlmConfig["providers"],
): string[] {
  if (ids.length < 3) {
    // 0 or 1 entries have nothing to order; 2 entries are head + one
    // fallback, and the only fallback keeps its place whatever its class.
    return [...ids];
  }
  const kindById = new Map(providers.map((p) => [p.id, p.kind]));
  const classOf = (id: string): ProviderClass =>
    providerClass(kindById.get(id));

  const [head, ...rest] = ids as [string, ...string[]];
  const primary = classOf(head);
  const near = rest.filter((id) => classOf(id) === primary);
  const far = rest.filter((id) => classOf(id) !== primary);
  return [head, ...near, ...far];
}

function resolveTiming(
  fallback: ResolvedLlmConfig["fallback"],
): FallbackTiming {
  if (!fallback) return DEFAULT_FALLBACK_TIMING;
  return {
    failureThreshold:
      fallback.failureThreshold ?? DEFAULT_FALLBACK_TIMING.failureThreshold,
    cooldownMs:
      fallback.cooldownMs && fallback.cooldownMs.length > 0
        ? fallback.cooldownMs
        : DEFAULT_FALLBACK_TIMING.cooldownMs,
    probeThrottleMs:
      fallback.probeThrottleMs ?? DEFAULT_FALLBACK_TIMING.probeThrottleMs,
    failureWindowMs:
      fallback.failureWindowMs ?? DEFAULT_FALLBACK_TIMING.failureWindowMs,
  };
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Drop chain links the provider registry could not build.
 *
 * The registry skips a non-active config entry whose factory throws (an
 * OpenAI-compatible entry with no model, say) instead of failing boot.
 * `resolveFallbackChain` reads the config only, so such an id would still
 * sit in the chain; falling over to it would then resolve to no provider,
 * quietly run the turn on the active one, and announce a switch that never
 * happened. The primary (index 0) is always kept: it is the active
 * provider, and the registry refuses to boot without it. `onDrop` is called
 * with each id removed, so the caller can log it.
 */
export function withoutUnbuiltLinks(
  resolved: ResolvedFallbackChain,
  isBuilt: (id: string) => boolean,
  onDrop?: (id: string) => void,
): ResolvedFallbackChain {
  return keepLinks(resolved, isBuilt, onDrop);
}

/**
 * Drop fallback links that have no API key for a service that wants one
 * (`lacksRequiredApiKey`).
 *
 * Such a link was configured but never set up, which is common: a desktop
 * import copies the terminal agent's `fallback.chain` and its provider
 * entries without their keys. Trying it only adds a guaranteed 401 to the
 * turn, filed as one more provider failing. Skipped instead, and the
 * caller says so (`onSkip`), so a skipped link never reads as a failure.
 *
 * The primary is always kept, keyless or not: it is the provider the user
 * picked, and its own refusal is the message they need. Like
 * `withoutUnbuiltLinks`, this is applied at runtime only; the config's
 * chain, and the Fallback pane that edits it, still list the link.
 */
export function withoutKeylessLinks(
  resolved: ResolvedFallbackChain,
  lacksKey: (id: string) => boolean,
  onSkip?: (id: string) => void,
): ResolvedFallbackChain {
  return keepLinks(resolved, (id) => !lacksKey(id), onSkip);
}

/**
 * Drop fallback links that cannot serve a turn on this machine right now
 * (`unavailable`) — in practice the auto-appended local link whose
 * managed model was never downloaded.
 *
 * Seen on Windows: the primary (`claude`, not installed) failed, the
 * chain fell over to `local-llama`, whose daemon cannot start without
 * weights, and that link's refused connection is what the turn then
 * waited on for five minutes as "no connection". A link like that is
 * not a backstop, so it is skipped, the caller says so (`onSkip`), and
 * it comes back the moment the model is on disk — the check runs on
 * every resolve. The primary is always kept: its own failure is the
 * message the user needs.
 */
export function withoutUnavailableLinks(
  resolved: ResolvedFallbackChain,
  unavailable: (id: string) => boolean,
  onSkip?: (id: string) => void,
): ResolvedFallbackChain {
  return keepLinks(resolved, (id) => !unavailable(id), onSkip);
}

/** Keep the primary and every later link `keep` accepts. */
function keepLinks(
  resolved: ResolvedFallbackChain,
  keep: (id: string) => boolean,
  onDrop?: (id: string) => void,
): ResolvedFallbackChain {
  const chain = resolved.chain.filter((id, i) => {
    if (i === 0 || keep(id)) return true;
    onDrop?.(id);
    return false;
  });
  return chain.length === resolved.chain.length ? resolved : { ...resolved, chain };
}
