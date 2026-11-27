import { splitProviderModel } from "../../llm/provider/provider-model-ref.js";
import type { TuiState } from "../tui-state.js";

/**
 * Favourite models (ATO-2169): a short ring of `provider/model` entries
 * the operator switches between with one key, mid-session. The pure half:
 * parsing, the current entry, and the next one. Persistence lives in
 * model-ring-store.ts, the switch itself in model-ring-actions.ts.
 *
 * Precedent: pi's scoped models (`/scoped-models`, `app.model.cycleForward`
 * on ctrl+p); LM Studio and Cursor pin favourite models above the list.
 */

/** One favourite. `provider` is a configured provider id; local models use `local-llama`. */
export interface ModelRingEntry {
  provider: string;
  model: string;
}

/** The managed local route's provider id, as everywhere else in the TUI. */
export const LOCAL_RING_PROVIDER = "local-llama";

/** A ring longer than this is the full list again, not a shortlist. */
export const MODEL_RING_MAX = 9;

/**
 * `provider/model` or `provider:model` (ATO-2773, the spelling `run -m`
 * takes), split on the FIRST separator: provider ids never carry one,
 * model ids often do (`openrouter/anthropic/claude-sonnet`,
 * `ollama/qwen3:8b`). Stored and shown with the slash.
 */
export function parseModelRingEntry(raw: string): ModelRingEntry | null {
  return splitProviderModel(raw);
}

export function formatModelRingEntry(entry: ModelRingEntry): string {
  return `${entry.provider}/${entry.model}`;
}

export function sameModelRingEntry(a: ModelRingEntry, b: ModelRingEntry): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** Entries kept in order, junk and repeats dropped, capped at MODEL_RING_MAX. */
export function cleanModelRing(raw: unknown): ModelRingEntry[] {
  const out: ModelRingEntry[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "string") continue;
    const entry = parseModelRingEntry(item);
    if (!entry || out.some((e) => sameModelRingEntry(e, entry))) continue;
    out.push(entry);
    if (out.length >= MODEL_RING_MAX) break;
  }
  return out;
}

/**
 * Add `entry` when it is not in the ring, take it out when it is. A full
 * ring drops its oldest entry to make room.
 */
export function toggleModelRingEntry(
  ring: readonly ModelRingEntry[],
  entry: ModelRingEntry,
): { ring: ModelRingEntry[]; added: boolean } {
  if (ring.some((e) => sameModelRingEntry(e, entry))) {
    return { ring: ring.filter((e) => !sameModelRingEntry(e, entry)), added: false };
  }
  const next = [...ring, entry];
  return {
    ring: next.length > MODEL_RING_MAX ? next.slice(next.length - MODEL_RING_MAX) : next,
    added: true,
  };
}

/**
 * The model the next turn runs on, as a ring entry, or null when it is
 * not one entry can name: Fusion runs two seats, an external llama.cpp
 * server is the operator's own, and a provider with no chat model yet
 * has nothing to switch back to.
 */
export function currentModelRingEntry(state: TuiState): ModelRingEntry | null {
  if (state.providersPanel.runMode?.effective === "fusion") return null;
  const active = state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  if (!active) return null;
  if (active.kind !== "llama-server") {
    return active.chatModel ? { provider: active.id, model: active.chatModel } : null;
  }
  const local = state.localModelsPanel;
  return local.configMode === "managed" && local.activeModelId
    ? { provider: LOCAL_RING_PROVIDER, model: local.activeModelId }
    : null;
}

/**
 * The entry after the current one, wrapping. Off the ring (or with no
 * current model) the first entry is next, so the key always lands on a
 * favourite. Null with an empty ring.
 */
export function nextModelRingEntry(
  ring: readonly ModelRingEntry[],
  current: ModelRingEntry | null,
): { entry: ModelRingEntry; index: number } | null {
  if (ring.length === 0) return null;
  const at = current ? ring.findIndex((e) => sameModelRingEntry(e, current)) : -1;
  const index = at < 0 ? 0 : (at + 1) % ring.length;
  const entry = ring[index];
  return entry ? { entry, index } : null;
}

/** The `/model favorite` listing: the ring in order, the current one marked. */
export function describeModelRing(
  ring: readonly ModelRingEntry[],
  current: ModelRingEntry | null,
): string {
  if (ring.length === 0) {
    return "No favorite models yet. /model favorite add puts the current model in; /model favorite add <provider/model> adds another.";
  }
  const lines = ring.map((e, i) => {
    const mark = current && sameModelRingEntry(e, current) ? "*" : " ";
    return `${mark} ${i + 1}. ${formatModelRingEntry(e)}`;
  });
  return ["Favorite models (ctrl+p switches to the next one):", ...lines].join("\n");
}
