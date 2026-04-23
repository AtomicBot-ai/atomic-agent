import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileListToolOptions {
  store: ProfileStore;
}

/**
 * `memory.profile.list {}` — return the full profile as key/value
 * entries. Read-only. The section is already rendered into every prompt
 * tail (subject to the contextual keyword gate), so this tool is mainly
 * useful when the LLM needs to inspect contextual/pinned metadata or
 * reason over specific fields explicitly.
 */
export function buildProfileListTool(
  options: ProfileListToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.list",
    description:
      "List every durable user profile fact (sorted by key) including pinned/keywords metadata.",
    readonly: true,
    async run() {
      const facts = options.store.list();
      const output =
        facts.length === 0
          ? "(empty profile)"
          : facts.map(renderFactLine).join("\n");
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
              pinned: f.pinned,
              keywords: f.keywords,
            })),
          },
        },
        { maxSummaryLength: 4000, maxTailLines: 200 },
      );
    },
  };
}

function renderFactLine(fact: {
  key: string;
  value: string;
  pinned: boolean;
  keywords: readonly string[];
}): string {
  const marker = fact.pinned ? "*" : "~";
  const tail =
    !fact.pinned && fact.keywords.length > 0
      ? ` [keywords: ${fact.keywords.join(", ")}]`
      : "";
  return `- ${marker} ${fact.key}: ${fact.value}${tail}`;
}
