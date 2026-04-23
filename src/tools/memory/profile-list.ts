import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileListToolOptions {
  store: ProfileStore;
}

/**
 * `memory.profile.list {}` — return the full profile as key/value
 * entries. Read-only. The section is already rendered into every prompt
 * tail, so this tool is mainly useful when the LLM needs to iterate or
 * reason over specific fields explicitly.
 */
export function buildProfileListTool(
  options: ProfileListToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.list",
    description: "List every durable user profile fact (sorted by key).",
    readonly: true,
    async run() {
      const facts = options.store.list();
      const output =
        facts.length === 0
          ? "(empty profile)"
          : facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
      return compressToolResult(
        {
          tool: "memory.profile.list",
          status: "ok",
          output,
          details: {
            count: facts.length,
            facts: facts.map((f) => ({
              key: f.key,
              value: f.value,
              updatedAt: f.updatedAt,
            })),
          },
        },
        { maxSummaryLength: 4000, maxTailLines: 200 },
      );
    },
  };
}
