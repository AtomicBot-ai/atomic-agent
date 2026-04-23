import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProfileStore,
  ProfileValidationError,
  type ProfileSetOptions,
} from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileSetToolOptions {
  store: ProfileStore;
}

/**
 * `memory.profile.set { key, value, pinned?, keywords? }` — upsert a
 * durable, cross-session profile fact. The written row lands in
 * `<stateDir>/memory.sqlite` and is rendered into the prompt tail via
 * the `### profile` section on the next turn.
 *
 * The `pinned` flag controls whether the fact is always emitted
 * (default: `true`) or only when one of its `keywords` appears in the
 * user message (`pinned=false`). Keywords are case-insensitive,
 * whole-word matches against the turn's user text and must be provided
 * alongside `pinned=false` to have any effect.
 *
 * Validation mirrors `ProfileStore.set` — invalid keys, values, or
 * keyword shapes surface as `status: error` tool results instead of
 * throwing.
 */
export function buildProfileSetTool(
  options: ProfileSetToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.set",
    description:
      "Upsert a durable user profile fact (cross-session). Keys identify the fact, values hold short text. Optional: pinned (default true) — when false, the fact only renders into `### profile` if one of its `keywords` matches the current user message. Use pinned=false for rarely-needed context (deploy commands, env vars, per-feature preferences) to keep the default prompt small.",
    readonly: false,
    async run(rawArgs) {
      const key = rawArgs.key;
      const value = rawArgs.value;
      try {
        const setOptions = parseSetOptions(rawArgs);
        const fact = options.store.set(
          typeof key === "string" ? key : "",
          typeof value === "string" ? value : "",
          setOptions,
        );
        return compressToolResult({
          tool: "memory.profile.set",
          status: "ok",
          output: renderOkOutput(fact.key, fact.value, fact.pinned, fact.keywords),
          details: {
            key: fact.key,
            value: fact.value,
            updatedAt: fact.updatedAt,
            pinned: fact.pinned,
            keywords: fact.keywords,
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

function parseSetOptions(rawArgs: Record<string, unknown>): ProfileSetOptions {
  const options: ProfileSetOptions = {};
  if (rawArgs.pinned !== undefined) {
    if (typeof rawArgs.pinned !== "boolean") {
      throw new ProfileValidationError(
        "keywords",
        "pinned must be a boolean",
      );
    }
    options.pinned = rawArgs.pinned;
  }
  if (rawArgs.keywords !== undefined) {
    if (!Array.isArray(rawArgs.keywords)) {
      throw new ProfileValidationError(
        "keywords",
        "keywords must be a string array",
      );
    }
    options.keywords = rawArgs.keywords as string[];
  }
  return options;
}

function renderOkOutput(
  key: string,
  value: string,
  pinned: boolean,
  keywords: readonly string[],
): string {
  const suffix = pinned
    ? ""
    : keywords.length > 0
      ? ` (contextual, keywords=[${keywords.join(", ")}])`
      : " (contextual, no keywords)";
  return `saved ${key} = ${truncatePreview(value)}${suffix}`;
}

function truncatePreview(value: string, max = 80): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
