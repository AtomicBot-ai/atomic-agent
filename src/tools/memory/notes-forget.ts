import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  MemoryStore,
  MemoryValidationError,
} from "../../memory/memory-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface NotesForgetToolOptions {
  store: MemoryStore;
}

/**
 * `memory.notes.forget { id }` — delete a stored note by id (as
 * returned from `memory.notes.recall`). Returns `removed: false` (not an
 * error) when the id was already absent so the LLM can distinguish
 * missing-row from validation failure.
 */
export function buildNotesForgetTool(
  options: NotesForgetToolOptions,
): ToolDefinition {
  return {
    name: "memory.notes.forget",
    description:
      "Delete a stored note by id returned from memory.notes.recall or memory.notes.list.",
    readonly: false,
    async run(rawArgs) {
      const id = rawArgs.id;
      try {
        const removed = options.store.remove(
          typeof id === "number" ? id : Number.NaN,
        );
        return compressToolResult({
          tool: "memory.notes.forget",
          status: "ok",
          output: removed ? `removed #${id}` : `no such id: ${id}`,
          details: { id, removed },
        });
      } catch (error) {
        if (error instanceof MemoryValidationError) {
          return compressToolResult({
            tool: "memory.notes.forget",
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
