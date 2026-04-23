import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  MemoryStore,
  MemoryValidationError,
} from "../../memory/memory-store.js";
import type { ToolDefinition } from "../tool-registry.js";

export interface NotesStoreToolOptions {
  store: MemoryStore;
  /** Hard cap on incoming `content`. Excess is rejected, not truncated. */
  maxContentChars: number;
}

/**
 * `memory.notes.store { content, tags? }` — persist a durable freeform
 * note across sessions. The entry is tagged with the current
 * `workingDir` and `sessionId` from the tool context so project-scoped
 * recall works without extra plumbing. Unlike `memory.profile.set`, the
 * note is NOT rendered into the prompt on subsequent turns — the agent
 * has to call `memory.notes.recall` to retrieve it.
 */
export function buildNotesStoreTool(
  options: NotesStoreToolOptions,
): ToolDefinition {
  return {
    name: "memory.notes.store",
    description:
      "Persist a durable freeform note across sessions. Use when the user says remember/save, or when you derive a stable observation worth recalling later. Notes are searchable via memory.notes.recall and are NOT auto-rendered into the prompt.",
    readonly: false,
    async run(rawArgs, ctx) {
      const content = rawArgs.content;
      if (typeof content === "string" && content.length > options.maxContentChars) {
        return compressToolResult({
          tool: "memory.notes.store",
          status: "error",
          output: `validation: content: must be at most ${options.maxContentChars} chars (got ${content.length})`,
          details: {
            field: "content",
            reason: `over maxContentChars=${options.maxContentChars}`,
          },
        });
      }
      try {
        const entry = options.store.store({
          content: typeof content === "string" ? content : "",
          tags: rawArgs.tags as string[] | undefined,
          sessionId: ctx.sessionId,
          workingDir: ctx.workingDir,
          source: "agent",
        });
        return compressToolResult({
          tool: "memory.notes.store",
          status: "ok",
          output: `stored #${entry.id}`,
          details: {
            id: entry.id,
            content: entry.content,
            tags: entry.tags,
            updatedAt: entry.updatedAt,
            stored: true,
          },
        });
      } catch (error) {
        if (error instanceof MemoryValidationError) {
          return compressToolResult({
            tool: "memory.notes.store",
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
