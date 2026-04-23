import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  MemoryStore,
  MemoryValidationError,
} from "../../memory/memory-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface NotesRecallToolOptions {
  store: MemoryStore;
  /** Default `k` when the caller omits it (comes from config). */
  defaultK: number;
}

/**
 * `memory.notes.recall { query?, id?, k?, scope?, tags? }` — two modes:
 *   - keyword search (default): BM25-ranked over the FTS5 index, driven
 *     by `query`. `scope` defaults to `"all"`; pass `"project"` to
 *     restrict to the current working directory.
 *   - direct fetch (when `id` is supplied): return the full note for
 *     that id, ignoring `query` / `k` / `scope`. Used by the agent when
 *     drilling into a pointer shown in `### memory-index`.
 */
export function buildNotesRecallTool(
  options: NotesRecallToolOptions,
): ToolDefinition {
  return {
    name: "memory.notes.recall",
    description:
      "Search or fetch durable notes. Pass { id } to fetch a single note by id (e.g. after spotting it in `### memory-index`). Otherwise pass { query } for a BM25 keyword search. Default scope is 'all' (cross-project); pass scope='project' to restrict to the current working directory.",
    readonly: true,
    async run(rawArgs, ctx) {
      if (rawArgs.id !== undefined) {
        return fetchById(rawArgs.id, options.store);
      }
      const query = rawArgs.query;
      if (typeof query !== "string") {
        return compressToolResult({
          tool: "memory.notes.recall",
          status: "error",
          output: `validation: query: expected string (or pass { id } for direct fetch), got ${typeof query}`,
          details: { field: "query", reason: "expected string" },
        });
      }
      const k =
        typeof rawArgs.k === "number" && Number.isInteger(rawArgs.k)
          ? rawArgs.k
          : options.defaultK;
      const scope = rawArgs.scope === "project" ? "project" : "all";
      try {
        const entries = options.store.recall(query, {
            k,
            scope,
            workingDir: scope === "project" ? ctx.workingDir : null,
            tags: rawArgs.tags as string[] | undefined,
          },
        );
        const output =
          entries.length === 0
            ? "(no matches)"
            : entries
                .map(
                  (e) => `- #${e.id} ${truncatePreview(e.content, 240)}`,
                )
                .join("\n");
        return compressToolResult(
          {
            tool: "memory.notes.recall",
            status: "ok",
            output,
            details: {
              count: entries.length,
              scope,
              entries: entries.map((e) => ({
                id: e.id,
                content: e.content,
                tags: e.tags,
                workingDir: e.workingDir,
                updatedAt: e.updatedAt,
              })),
            },
          },
          { maxSummaryLength: 4000, maxTailLines: 200 },
        );
      } catch (error) {
        if (error instanceof MemoryValidationError) {
          return compressToolResult({
            tool: "memory.notes.recall",
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

function truncatePreview(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}

/**
 * Direct-fetch path for `memory.notes.recall { id }`. Returns the full
 * note (not a preview) so the agent has the exact body to act on. An
 * unknown id maps to a deterministic `(not found)` output rather than
 * an error, matching the "zero results" shape of the BM25 path.
 */
function fetchById(rawId: unknown, store: MemoryStore) {
  if (typeof rawId !== "number" || !Number.isInteger(rawId) || rawId <= 0) {
    return compressToolResult({
      tool: "memory.notes.recall",
      status: "error",
      output: `validation: id: expected positive integer, got ${JSON.stringify(rawId)}`,
      details: { field: "id", reason: "expected positive integer" },
    });
  }
  try {
    const entry = store.get(rawId);
    if (entry === null) {
      return compressToolResult({
        tool: "memory.notes.recall",
        status: "ok",
        output: `(no note with id ${rawId})`,
        details: { count: 0, scope: "id" as const, entries: [] },
      });
    }
    return compressToolResult(
      {
        tool: "memory.notes.recall",
        status: "ok",
        output: `- #${entry.id} ${entry.content}`,
        details: {
          count: 1,
          scope: "id" as const,
          entries: [
            {
              id: entry.id,
              content: entry.content,
              tags: entry.tags,
              workingDir: entry.workingDir,
              updatedAt: entry.updatedAt,
            },
          ],
        },
      },
      { maxSummaryLength: 4000, maxTailLines: 200 },
    );
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      return compressToolResult({
        tool: "memory.notes.recall",
        status: "error",
        output: `validation: ${error.field}: ${error.message}`,
        details: { field: error.field, reason: error.message },
      });
    }
    throw error;
  }
}
