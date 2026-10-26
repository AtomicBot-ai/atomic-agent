/**
 * ATO-1041 — the starter model, fetched on the first launch.
 *
 * Nadya 25.10: no model in the installer; the app downloads a small one
 * (Qwen 3.5 2B, 1.3 GB, the agent's STARTER_LOCAL_MODEL_ID) when it starts
 * with nothing to answer on: no chat model on disk and no cloud provider
 * with a key. Once it is on disk the app routes to it, so the first chat
 * answers without a key (ATO-1042 opens the chat on it). Anyone who already
 * has a model or a cloud key is left alone.
 *
 * Pure: the caller hands in what the agent reports.
 */

/** The agent's STARTER_LOCAL_MODEL_ID (src/local-llm/catalog/models-catalog.ts). */
export const STARTER_MODEL_ID = "qwen-3.5-2b";

export interface StarterInputs {
  /** `atag models list` (chat models only): ids and whether each is on disk. */
  chatModels: Array<{ id: string; downloaded: boolean }> | null;
  /** Whether a cloud provider with a usable key is configured. */
  cloudReady: boolean;
  /** `localModels.mode`: an external server (Ollama, LM Studio) is the person's own choice. */
  localMode?: string | null;
  /** Offered once already (userData/starter.json): a removed or failed starter is not fetched again on every launch. */
  offeredBefore?: boolean;
}

export type StarterVerdict =
  | { fetch: true }
  | { fetch: false; why: "has_model" | "has_cloud" | "unknown" | "not_in_catalog" | "external" | "offered" };

export function starterVerdict(i: StarterInputs): StarterVerdict {
  if (i.offeredBefore) return { fetch: false, why: "offered" };
  if (i.cloudReady) return { fetch: false, why: "has_cloud" };
  if (i.localMode && i.localMode !== "managed") return { fetch: false, why: "external" };
  if (!i.chatModels) return { fetch: false, why: "unknown" };
  if (i.chatModels.some((m) => m.downloaded)) return { fetch: false, why: "has_model" };
  // An agent from before the starter entry does not list it: nothing to fetch.
  if (!i.chatModels.some((m) => m.id === STARTER_MODEL_ID)) return { fetch: false, why: "not_in_catalog" };
  return { fetch: true };
}

/**
 * Whether the finished download should become the route: the person did not
 * choose anything else meanwhile (a cloud key, another model on disk, another
 * active provider).
 */
export function starterStillWanted(i: { chatModels: Array<{ id: string; downloaded: boolean }> | null; cloudReady: boolean; activeProvider: string | null }): boolean {
  if (i.cloudReady) return false;
  if (i.activeProvider && i.activeProvider !== "local-llama") return false;
  return !(i.chatModels ?? []).some((m) => m.downloaded && m.id !== STARTER_MODEL_ID);
}
