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
 * `memory.notes.recall { query, k?, scope?, tags? }` — BM25 keyword
 * search over stored notes. `scope` defaults to `"all"` (cross-project);
 * pass `"project"` to restrict to the current working directory.
 * Returns at most `k` entries ranked by BM25.
 */
export function buildNotesRecallTool(
  options: NotesRecallToolOptions,
): ToolDefinition {
  return {
    name: "memory.notes.recall",
    description:
      "Search durable notes by keyword (BM25). Call before answering questions that reference past sessions, user preferences, or project history. Default scope is 'all' (cross-project); pass scope='project' to restrict to the current working directory.",
    readonly: true,
    async run(rawArgs, ctx) {
      const query = rawArgs.query;
      if (typeof query !== "string") {
        return compressToolResult({
          tool: "memory.notes.recall",
          status: "error",
          output: `validation: query: expected string, got ${typeof query}`,
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
