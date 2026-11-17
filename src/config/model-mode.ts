import { isSetAsideString } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";
import type { UserLlmProviderEntry } from "./llm-config.js";
import { usesExternalCliAuth } from "./provider-auth-mode.js";
import { cloudPresetForUrl } from "../llm/provider/presets/provider-presets.js";

/** Runtime policy, independent of provider location and tool transport. */
export type ModelMode = "local" | "cloud";
const MODEL_MODES: readonly ModelMode[] = ["local", "cloud"];

/** Shared by new connections and the v75 migration; never a runtime override. */
export function defaultProviderModelMode(
  entry: Pick<UserLlmProviderEntry, "kind" | "baseUrl" | "subscriptionCli">,
): ModelMode {
  if (
    entry.kind === "openrouter" || entry.kind === "aimlapi" ||
    entry.kind === "gemini" || usesExternalCliAuth(entry)
  ) return "cloud";
  if (entry.kind !== "openai-compatible" || !entry.baseUrl) return "local";
  try {
    // Match a known service, not a user-chosen entry id or arbitrary remote URL.
    // URL parsing handles casing, trailing slashes and /v1 API roots alike.
    // Per-account endpoints (an Azure resource, a Bedrock Region) match
    // by their preset's host pattern instead (`cloudPresetForUrl`).
    const origin = new URL(entry.baseUrl).origin;
    if (
      origin === "https://api.openai.com" ||
      cloudPresetForUrl(entry.baseUrl) !== undefined
    ) return "cloud";
  } catch {
    // Unknown/custom endpoints keep the conservative local policy.
  }
  return "local";
}

export function parseModelMode(raw: unknown, field: string): ModelMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "local" || raw === "cloud") return raw;
  throw new ConfigValidationError(field, "expected local|cloud");
}

/**
 * ATO-1241: reading the file, a mode a newer build added is left unset
 * (the provider's own policy applies) with one notice. Typed input goes
 * through the strict `parseModelMode`.
 */
export function readModelMode(raw: unknown, field: string): ModelMode | undefined {
  if (isSetAsideString(raw, MODEL_MODES, field, undefined)) return undefined;
  return parseModelMode(raw, field);
}

/** `fromFile`: a per-model mode a newer build added is dropped from the map (see `readModelMode`). */
export function parseModelModes(raw: unknown, field: string, fromFile = false): Record<string, ModelMode> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object mapping model ids to local|cloud");
  }
  const out: Array<[string, ModelMode]> = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim()) throw new ConfigValidationError(field, "model id must not be empty");
    if (fromFile && isSetAsideString(value, MODEL_MODES, `${field}.${id}`, undefined)) continue;
    const mode = parseModelMode(value, `${field}.${id}`);
    if (mode === undefined) throw new ConfigValidationError(`${field}.${id}`, "expected local|cloud");
    out.push([id, mode]);
  }
  return Object.fromEntries(out);
}
