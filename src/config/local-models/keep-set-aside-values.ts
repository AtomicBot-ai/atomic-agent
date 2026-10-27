import { isKnownLocalModelId } from "../../local-llm/catalog/models-catalog.js";
import { isBackendVariantPreference } from "../../local-llm/backend/windows-backend-variant.js";
import type { UserConfigFile } from "../config-schema.js";

/**
 * ATO-1239 — the write half of reading a newer build's choices leniently.
 * On read, a managed model id, engine or backend variant this build does
 * not know is set aside (null / the default). A whole-file write of that
 * parsed config would then put null or the default over the value the
 * newer build (the desktop app sharing the folder) wrote. So the value on
 * disk is kept whenever this build still holds the stand-in it read: the
 * operator choosing a model, an engine or a variant here still replaces it.
 */
export function keepSetAsideLocalModelValues(data: UserConfigFile, disk: Record<string, unknown>): UserConfigFile {
  const lm = disk.localModels;
  const dm = lm && typeof lm === "object" && !Array.isArray(lm) ? (lm as Record<string, unknown>).managed : null;
  if (!dm || typeof dm !== "object" || Array.isArray(dm)) return data;
  const onDisk = dm as Record<string, unknown>;
  const managed = data.localModels.managed;
  const keep: Record<string, unknown> = {};
  const id = onDisk.modelId;
  if (typeof id === "string" && managed.modelId === null && !isKnownLocalModelId(id)
    && !data.localModels.customModels.some((m) => m.id === id)) {
    keep.modelId = id;
  }
  const engine = onDisk.engine;
  if (typeof engine === "string" && engine.length > 0 && engine !== "llama-server" && engine !== "atomic-core") keep.engine = engine;
  const variant = onDisk.backendVariant;
  if (typeof variant === "string" && variant.length > 0 && !isBackendVariantPreference(variant)) keep.backendVariant = variant;
  if (Object.keys(keep).length === 0) return data;
  return { ...data, localModels: { ...data.localModels, managed: { ...managed, ...keep } as typeof managed } };
}
