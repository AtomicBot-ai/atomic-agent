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
import { isFallbackPanelAction } from "./fallback-panel-actions.js";
import { buildFallbackChainView } from "./fallback-panel-selectors.js";

/**
 * The only TUI module that writes `llm.fallback.chain` /
 * `llm.fallback.appendLocal`. Mirrors `ProvidersOrchestrator`: it
 * listens on the event bus for the side-effectful fallback intents,
 * turns each into a config write via `setFallbackChainInConfig`, and
 * emits a `fallback_refresh` re-mirroring the effective chain the loader
 * now resolves. The engine re-reads config every turn (`resetConfigCache`
 * inside the persist), so a write takes effect on the next completion
 * without a restart — nothing else writes this block, so there is no
 * contention with the runtime `ProviderFallbackChain`.
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
        return;
      }
      if (!isFallbackPanelAction(action)) return;
      switch (action.type) {
        case "fallback_move_requested":
          this.applyEdit(() =>
            moveLink(this.currentLinks(), action.providerId, action.delta),
          );
          break;
        case "fallback_add_requested":
          this.applyEdit(() => addLink(this.currentLinks(), action.providerId));
          break;
        case "fallback_remove_requested":
          this.applyEdit(() =>
            removeLink(this.currentLinks(), action.providerId),
          );
          break;
        case "fallback_append_local_toggle_requested":
          this.toggleAppendLocal();
          break;
        default:
          break;
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

  private toggleAppendLocal(): void {
    const view = buildFallbackChainView(resolveLlmConfig(getConfig()));
    // Persist the operator's explicit chain (the displayed links minus
    // the auto-appended local one) with the flag flipped.
    const declared = view.links
      .filter((l) => !l.isAppendedLocal)
      .map((l) => l.providerId);
    this.persist(declared, !view.appendLocal);
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
