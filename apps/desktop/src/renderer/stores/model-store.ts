import { create } from "zustand";

import {
  fetchModelsStatus,
  listProviders,
  setActiveProvider,
  type ModelsStatus,
  type ProviderSummary,
} from "@/lib/agent-api";

interface ModelStoreState {
  status: ModelsStatus | null;
  providers: ProviderSummary[];
  activeTextId: string | null;
  /** Pull backend status + provider list; swallows failures (best-effort). */
  refresh: () => Promise<void>;
  /** Hot-swap the active text provider, then re-pull status + list. */
  setActive: (id: string) => Promise<void>;
}

/**
 * Mirror of the active LLM backend: `models.status` (reachability, latency,
 * active model, context window) plus the registered provider list
 * (`provider.list`). Powers the top-bar model pill / switcher and the
 * Settings → Models page. Refreshed on boot and after every finished turn —
 * never on a hot path.
 */
export const useModelStore = create<ModelStoreState>((set, get) => ({
  status: null,
  providers: [],
  activeTextId: null,
  refresh: async () => {
    // Independent try/catch so a failure in one call never blanks the other.
    try {
      const status = await fetchModelsStatus();
      set({ status });
    } catch {
      // Non-fatal: keep the last known status.
    }
    try {
      const snapshot = await listProviders();
      set({
        providers: snapshot.providers,
        activeTextId: snapshot.activeTextId,
      });
    } catch {
      // Non-fatal: keep the last known provider list.
    }
  },
  setActive: async (id) => {
    try {
      const activeTextId = await setActiveProvider(id);
      set({ activeTextId });
    } catch {
      // Non-fatal: the refresh below reconciles the true active id.
    }
    await get().refresh();
  },
}));
