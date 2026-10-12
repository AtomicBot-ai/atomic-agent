import { ConfigValidationError } from "./config-validation-error.js";
import type { UserLlmProviderEntry } from "./llm-config.js";
import { usesExternalCliAuth } from "./provider-auth-mode.js";
import { PROVIDER_PRESETS } from "../llm/provider/presets/provider-presets.js";

/** Runtime policy, independent of provider location and tool transport. */
export type ModelMode = "local" | "cloud";

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
    const origin = new URL(entry.baseUrl).origin;
    if (
      origin === "https://api.openai.com" ||
      PROVIDER_PRESETS.some((preset) =>
        !preset.local && new URL(preset.baseUrl).origin === origin)
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

export function parseModelModes(raw: unknown, field: string): Record<string, ModelMode> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object mapping model ids to local|cloud");
  }
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
    if (!id.trim()) throw new ConfigValidationError(field, "model id must not be empty");
    const mode = parseModelMode(value, `${field}.${id}`);
    if (mode === undefined) throw new ConfigValidationError(`${field}.${id}`, "expected local|cloud");
    return [id, mode];
  }));
}
