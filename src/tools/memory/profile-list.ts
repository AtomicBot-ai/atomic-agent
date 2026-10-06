import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ProfileStore } from "../../memory/profile-store.js";
import {
  nameGroundingMarker,
  type NameGroundingStatus,
} from "../../memory/profile-name-keys.js";
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
 *
 * Lists every active fact, including a name the user never wrote
 * (ATO-199): such a name is kept out of `### profile` but shown here,
 * marked, so the agent can ask the user to confirm it or remove it.
 */
export function buildProfileListTool(
  options: ProfileListToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.list",
    description:
      "List every durable user profile fact (sorted by key) including pinned/keywords metadata. A name marked unconfirmed was never written by the user and is not in `### profile`: do not call the user by it; ask them to confirm it (then memory.profile.set it) or remove it (memory.profile.remove).",
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
              ...(f.nameGrounding !== undefined && f.nameGrounding !== null
                ? { nameGrounding: f.nameGrounding }
                : {}),
              ...(nameGroundingMarker(f) !== null ? { unconfirmed: true } : {}),
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
  nameGrounding?: NameGroundingStatus | null;
}): string {
  const marker = fact.pinned ? "*" : "~";
  const tail =
    !fact.pinned && fact.keywords.length > 0
      ? ` [keywords: ${fact.keywords.join(", ")}]`
      : "";
  const grounding = nameGroundingMarker(fact);
  return `- ${marker} ${fact.key}: ${fact.value}${tail}${grounding !== null ? ` (${grounding})` : ""}`;
}
