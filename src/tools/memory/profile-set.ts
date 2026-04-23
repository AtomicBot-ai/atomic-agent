import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProfileStore,
  ProfileValidationError,
} from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileSetToolOptions {
  store: ProfileStore;
}

/**
 * `memory.profile.set { key, value }` — upsert a durable, cross-session
 * profile fact. The written row lands in `<stateDir>/memory.sqlite` and
 * is rendered into the prompt tail via the `### profile` section on the
 * next turn. Validation mirrors `ProfileStore.set` — invalid keys or
 * values surface as `status: error` tool results instead of throwing.
 */
export function buildProfileSetTool(
  options: ProfileSetToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.set",
    description:
      "Upsert a durable user profile fact (cross-session). Keys identify the fact, values hold short text.",
    readonly: false,
    async run(rawArgs) {
      const key = rawArgs.key;
      const value = rawArgs.value;
      try {
        const fact = options.store.set(
          typeof key === "string" ? key : "",
          typeof value === "string" ? value : "",
        );
        return compressToolResult({
          tool: "memory.profile.set",
          status: "ok",
          output: `saved ${fact.key} = ${truncatePreview(fact.value)}`,
          details: {
            key: fact.key,
            value: fact.value,
            updatedAt: fact.updatedAt,
            updated: true,
          },
        });
      } catch (error) {
        if (error instanceof ProfileValidationError) {
          return compressToolResult({
            tool: "memory.profile.set",
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

function truncatePreview(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
