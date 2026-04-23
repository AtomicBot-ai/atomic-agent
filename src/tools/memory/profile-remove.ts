import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProfileStore,
  ProfileValidationError,
} from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileRemoveToolOptions {
  store: ProfileStore;
}

/**
 * `memory.profile.remove { key }` — delete a profile fact. Returns
 * `removed: false` (not an error) when the key was already absent so the
 * LLM can distinguish missing-key from validation failure.
 */
export function buildProfileRemoveTool(
  options: ProfileRemoveToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.remove",
    description: "Delete a durable user profile fact by key.",
    readonly: false,
    async run(rawArgs) {
      const key = rawArgs.key;
      try {
        const removed = options.store.remove(
          typeof key === "string" ? key : "",
        );
        return compressToolResult({
          tool: "memory.profile.remove",
          status: "ok",
          output: removed
            ? `removed ${String(key)}`
            : `no such key: ${String(key)}`,
          details: { key: String(key), removed },
        });
      } catch (error) {
        if (error instanceof ProfileValidationError) {
          return compressToolResult({
            tool: "memory.profile.remove",
            status: "error",
            output: `validation: ${error.field}: ${error.message}`,
            details: { field: error.field, reason: error.message },
          });
        }
        throw error;
      }
    },
  };
}
