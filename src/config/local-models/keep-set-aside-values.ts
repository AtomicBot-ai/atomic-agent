import { isKnownLocalModelId } from "../../local-llm/catalog/models-catalog.js";
import type { UserConfigFile } from "../config-schema.js";

/**
 * ATO-1239 — the write half of reading a newer build's choices leniently.
 * On read, a managed model id this build does not know is set aside
 * (null). A whole-file write of that parsed config would then put null
 * over the id the newer build (the desktop app sharing the folder) wrote.
 * So the id on disk is kept whenever this build still holds no model: the
 * operator choosing a model here still replaces it. The engine and backend
 * variant follow the general rule in `keepSetAsideConfigValues` (ATO-1265).
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
  if (Object.keys(keep).length === 0) return data;
  return { ...data, localModels: { ...data.localModels, managed: { ...managed, ...keep } as typeof managed } };
}
