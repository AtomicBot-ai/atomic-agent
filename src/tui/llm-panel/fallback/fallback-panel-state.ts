/**
 * TUI mirror of the effective provider fallback chain. Owned by
 * `FallbackOrchestrator`, which reads `resolveLlmConfig` + the stored
 * `llm.fallback` block and rebuilds `links` on every refresh — the same
 * one-writer discipline `ProvidersPanelState.rows` follows.
 *
 * The chain shown here is the *effective* order from
 * `resolveFallbackChain`: the active text provider is always the head
 * (`isActive`) and the local last-resort link is flagged (`isAppendedLocal`)
 * when `appendLocal` synthesised it rather than the operator listing it
 * explicitly. Reordering, add and remove all persist the operator's
 * declared `chain` (see `FallbackOrchestrator`), never the synthesised
 * tail.
 */
export interface FallbackLinkRow {
  /** Configured provider id (the chain unit). */
  providerId: string;
  /** Model label pinned to this provider, or null when none is configured. */
  modelLabel: string | null;
  /** Provider kind (`openrouter`, `llama-server`, ...). */
  kind: string;
  /** True for the head link — the active text provider (the primary). */
  isActive: boolean;
  /**
   * True when this link is the auto-appended local last resort
   * (`appendLocal`), not an explicit `chain` entry. Such a link is not
   * reorderable or removable from the pane — it is toggled off by
   * `appendLocal`.
   */
  isAppendedLocal: boolean;
}

/**
 * The last provider switch the TUI observed via a `provider_switched`
 * `AgentLoopEvent`. This is the only *live* signal the pane has: the
 * runtime `ProviderFallbackChain` instance (which owns the cooldown
 * timers) is not reachable from the TUI, so the pane never invents a
 * live countdown. `direction: "away"` means the primary was unreachable
 * and the chain failed over to `to`; `"back"` means a probe recovered
 * the primary. Cleared to `null` until the first switch of the session.
 */
export interface FallbackLastSwitch {
  direction: "away" | "back";
  from: string;
  to: string;
  reason: string;
}

export interface FallbackPanelState {
  /** Effective chain order, primary first. Empty until first refresh. */
  links: readonly FallbackLinkRow[];
  /**
   * Configured providers not currently in the chain, offered by the
   * "add link" affordance. Empty when every provider is already a link.
   */
  addableProviderIds: readonly string[];
  /** Stored `llm.fallback.appendLocal` (default true when unset). */
  appendLocal: boolean;
  /** Last observed cross-provider switch, or null. */
  lastSwitch: FallbackLastSwitch | null;
  /** Non-null while the add-link picker owns the keyboard. */
  addPicker: FallbackAddPickerState | null;
  /** Transient status/error line (e.g. a rejected persist), or null. */
  statusLine: string | null;
}

/**
 * The add-link picker: a cursor over `addableProviderIds`. A non-null
 * value means the picker owns the keyboard (↑/↓ to move, Enter to append
 * the chosen provider, Esc to cancel).
 */
export interface FallbackAddPickerState {
  cursor: number;
}

export function createInitialFallbackPanelState(): FallbackPanelState {
  return {
    links: [],
    addableProviderIds: [],
    appendLocal: true,
    lastSwitch: null,
    addPicker: null,
    statusLine: null,
  };
}
