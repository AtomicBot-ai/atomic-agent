import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProfileStore,
  ProfileValidationError,
  type ProfileFact,
} from "../../memory/profile-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface ProfileHistoryToolOptions {
  store: ProfileStore;
}

/**
 * Memory-v2 phase 4. `memory.profile.history { key }` — return the
 * full bi-temporal chain for `key`. Returns rows in **temporal order**
 * (oldest first); the active row, when present, is the last entry.
 *
 * The full chain (active + every superseded version) is included.
 * Useful when the user asks "what did I prefer before?" — the
 * default `### profile` view shows only the active row, this tool
 * lifts the veil on the chain. The tool itself is read-only and the
 * underlying store guarantees `content`-equivalent data integrity
 * (every prior value is preserved verbatim in `profile_facts`).
 */
export function buildProfileHistoryTool(
  options: ProfileHistoryToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.history",
    description:
      "Return the full bi-temporal history of a profile key, oldest first. Useful for answering 'what did I prefer / what was it before?' questions. The current active value is the last entry; earlier entries are superseded versions.",
    readonly: true,
    async run(rawArgs) {
      const keyRaw = rawArgs.key;
      try {
        const chain = options.store.history(
          typeof keyRaw === "string" ? keyRaw : "",
        );
        if (chain.length === 0) {
          return compressToolResult({
            tool: "memory.profile.history",
            status: "ok",
            output: `(no history for key ${stringifyKey(keyRaw)})`,
            details: { key: keyRaw, count: 0, history: [] },
          });
        }
        return compressToolResult(
          {
            tool: "memory.profile.history",
            status: "ok",
            output: chain.map(renderHistoryLine).join("\n"),
            details: {
              key: chain[0]?.key,
              count: chain.length,
              history: chain.map((row) => ({
                id: row.id,
                value: row.value,
                validFrom: row.validFrom,
                supersededBy: row.supersededBy,
                supersedes: row.supersedes,
                active: row.supersededBy === null,
              })),
            },
          },
          { maxSummaryLength: 4000, maxTailLines: 200 },
        );
      } catch (error) {
        if (error instanceof ProfileValidationError) {
          return compressToolResult({
            tool: "memory.profile.history",
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

function stringifyKey(raw: unknown): string {
  return typeof raw === "string" && raw.length > 0 ? raw : "<missing>";
}

function renderHistoryLine(row: ProfileFact): string {
  const active = row.supersededBy === null;
  const marker = active ? "*" : " ";
  const timestamp = new Date(row.validFrom).toISOString();
  const tail = active ? " (active)" : ` → #${row.supersededBy}`;
  return `${marker} [#${row.id}] ${timestamp}: ${truncate(row.value)}${tail}`;
}

function truncate(value: string, max = 160): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
