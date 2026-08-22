import { getConfig } from "../../../config/index.js";
import { resolveLlmConfig } from "../../../llm/provider/registry/index.js";
import {
  setFallbackChainInConfig,
  wrapLlmConfigError,
} from "../../persist-llm-provider.js";
import type { TuiEventBus } from "../../tui-app.js";
import {
  addLink,
  moveLink,
  removeLink,
  type ChainEditResult,
} from "./fallback-chain-edits.js";
import { buildFallbackChainView } from "./fallback-panel-selectors.js";

/**
 * The only TUI module that writes `llm.fallback.chain` /
 * `llm.fallback.appendLocal`. Mirrors `ProvidersOrchestrator`: the edit
 * methods (`move`/`add`/`remove`/`toggleAppendLocal`) are called through
 * the `TuiAppCallbacks.onFallback*` callbacks wired in `tui-command.ts` —
 * NOT via dispatched reducer actions, which never reach this class (the
 * bus→dispatch bridge is one-way; that trap is why the pane's edits were
 * silent no-ops before). Each edit becomes a config write via
 * `setFallbackChainInConfig`, followed by a `fallback_refresh` emitted on
 * the bus re-mirroring the effective chain the loader now resolves. The
 * engine re-reads config every turn (`resetConfigCache` inside the
 * persist), so a write takes effect on the next completion without a
 * restart — nothing else writes this block, so there is no contention
 * with the runtime `ProviderFallbackChain`.
 */
export class FallbackOrchestrator {
  constructor(
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {
    this.bus.subscribe((action) => {
      // A provider mutation (activate/select/add/remove) re-emits
      // `providers_refresh`; re-mirror so the displayed head follows the
      // active text provider immediately, not only on tab re-entry. This
      // never writes config — it just re-reads the effective chain.
      if (
        typeof (action as { type?: unknown }).type === "string" &&
        (action as { type: string }).type === "providers_refresh"
      ) {
        this.refresh();
      }
    });
  }

  /** Re-mirror the effective chain from live config (no write). */
  refresh(): void {
    const view = buildFallbackChainView(resolveLlmConfig(getConfig()));
    this.bus.emit({
      type: "fallback_refresh",
      links: view.links,
      addableProviderIds: view.addableProviderIds,
      appendLocal: view.appendLocal,
    });
  }

  /** Move `providerId` one slot up (−1) or down (+1) and persist. */
  move(providerId: string, delta: -1 | 1): void {
    this.applyEdit(() => moveLink(this.currentLinks(), providerId, delta));
  }

  /** Append `providerId` to the declared chain tail and persist. */
  add(providerId: string): void {
    this.applyEdit(() => addLink(this.currentLinks(), providerId));
  }

  /** Drop `providerId` from the declared chain and persist. */
  remove(providerId: string): void {
    this.applyEdit(() => removeLink(this.currentLinks(), providerId));
  }

  /** Flip `llm.fallback.appendLocal` and persist. */
  toggleAppendLocal(): void {
    const view = buildFallbackChainView(resolveLlmConfig(getConfig()));
    // Persist the operator's explicit chain (the displayed links minus
    // the auto-appended local one) with the flag flipped.
    const declared = view.links
      .filter((l) => !l.isAppendedLocal)
      .map((l) => l.providerId);
    this.persist(declared, !view.appendLocal);
  }

  private currentLinks() {
    return buildFallbackChainView(resolveLlmConfig(getConfig())).links;
  }

  private applyEdit(compute: () => ChainEditResult): void {
    const view = buildFallbackChainView(resolveLlmConfig(getConfig()));
    const { chain } = compute();
    if (chain === null) {
      // Clamped/refused edit — nothing to persist, keep the pane quiet.
      return;
    }
    this.persist(chain, view.appendLocal);
  }

  private persist(chain: readonly string[], appendLocal: boolean): void {
    try {
      setFallbackChainInConfig(chain, appendLocal);
      this.bus.emit({ type: "fallback_status", line: null });
      this.refresh();
    } catch (err) {
      this.bus.emit({
        type: "fallback_status",
        line: wrapLlmConfigError(err),
      });
    }
  }
}
