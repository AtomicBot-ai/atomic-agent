import type { FallbackLinkRow } from "./fallback-panel-state.js";

/**
 * Pure chain-edit algebra shared by the orchestrator and its tests. Each
 * function takes the pane's *displayed* links (the effective order) and
 * returns the new **declared** `chain` to persist — the list minus the
 * auto-appended local last resort, which `appendLocal` re-synthesises on
 * read. The engine's `resolveFallbackChain` then re-hoists the active
 * provider to the head, so persisting the effective order verbatim is
 * stable across a round-trip.
 *
 * All edits are clamped: a move past either end is a no-op (returns the
 * same declared order), and removing the active head or the appended
 * local link is refused (the active provider is always the primary; the
 * local link is governed by the `appendLocal` toggle, not by removal).
 */

/** Declared chain = displayed links minus the auto-appended local one. */
function declaredChain(links: readonly FallbackLinkRow[]): string[] {
  return links.filter((l) => !l.isAppendedLocal).map((l) => l.providerId);
}

/** Indices of the reorderable links (everything but the appended local). */
function reorderableCount(links: readonly FallbackLinkRow[]): number {
  return links.filter((l) => !l.isAppendedLocal).length;
}

export interface ChainEditResult {
  /** The new declared chain to persist, or null when the edit is a no-op. */
  chain: string[] | null;
}

/**
 * Move `providerId` one slot up (delta −1) or down (+1) within the
 * declared chain. Clamped: moving the first link up, the last reorderable
 * link down, or an unknown/appended-local id is a no-op.
 */
export function moveLink(
  links: readonly FallbackLinkRow[],
  providerId: string,
  delta: -1 | 1,
): ChainEditResult {
  const chain = declaredChain(links);
  const from = chain.indexOf(providerId);
  if (from < 0) return { chain: null };
  const to = from + delta;
  if (to < 0 || to >= chain.length) return { chain: null };
  const next = [...chain];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return { chain: next };
}

/**
 * Append `providerId` to the declared chain tail. No-op when it is
 * already present (a provider is a single chain unit).
 */
export function addLink(
  links: readonly FallbackLinkRow[],
  providerId: string,
): ChainEditResult {
  const chain = declaredChain(links);
  if (chain.includes(providerId)) return { chain: null };
  return { chain: [...chain, providerId] };
}

/**
 * Remove `providerId` from the declared chain. Refused (no-op) for the
 * active head — it is always the primary — and for the auto-appended
 * local link, which is governed by `appendLocal`. Removing the last
 * remaining reorderable link is also refused so the chain never becomes
 * empty out from under the primary.
 */
export function removeLink(
  links: readonly FallbackLinkRow[],
  providerId: string,
): ChainEditResult {
  const target = links.find((l) => l.providerId === providerId);
  if (!target || target.isActive || target.isAppendedLocal) {
    return { chain: null };
  }
  if (reorderableCount(links) <= 1) return { chain: null };
  return { chain: declaredChain(links).filter((id) => id !== providerId) };
}
