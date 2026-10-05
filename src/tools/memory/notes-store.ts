import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  MEMORY_MAX_TAGS,
  MemoryStore,
  MemoryValidationError,
} from "../../memory/memory-store.js";
import {
  nameGroundingAcrossSessions,
  type GroundingConversationSource,
} from "../../memory/name-grounding.js";
import { ungroundedClaimedNames } from "../../memory/reflection/reflection-grounding.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";

export interface NotesStoreToolOptions {
  store: MemoryStore;
  /** Hard cap on incoming `content`. Excess is rejected, not truncated. */
  maxContentChars: number;
  /**
   * ATO-200. Every stored session's user messages, to tell a name the
   * user gave in an earlier session from one they never gave.
   */
  groundingSource?: GroundingConversationSource;
}

/**
 * ATO-200. Tag on a note that names the user by a name they never
 * wrote. The note is kept — blocking a note is not this tool's call —
 * but the tag and the tool result say the name is not known.
 */
export const UNCONFIRMED_NAME_TAG = "unconfirmed-name";

/**
 * `memory.notes.store { content, tags? }` — persist a durable freeform
 * note across sessions. The entry is tagged with the current
 * `workingDir` and `sessionId` from the tool context so project-scoped
 * recall works without extra plumbing. Unlike `memory.profile.set`, the
 * note is NOT rendered into the prompt on subsequent turns — the agent
 * has to call `memory.notes.recall` to retrieve it.
 *
 * ATO-200. A note that names the user ("Пользователь Анна…", "The user
 * is Anna") by a name no user message carries is still stored, tagged
 * `unconfirmed-name`, and the result tells the model the name is not
 * known. Nothing ever reads a note as evidence for a name:
 * `memory.profile.set` and the startup check only accept the user's own
 * messages.
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
      if (
        typeof content === "string" &&
        content.length > options.maxContentChars
      ) {
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
        const text = typeof content === "string" ? content : "";
        const unconfirmed = await unconfirmedNames(
          text,
          ctx,
          options.groundingSource,
        );
        const rawTags = rawArgs.tags as string[] | undefined;
        // Malformed tags go through untouched, so validation still
        // reports them; a full tag list keeps its own tags.
        const tagged =
          unconfirmed.length > 0 &&
          (rawTags === undefined ||
            (Array.isArray(rawTags) && rawTags.length < MEMORY_MAX_TAGS));
        const entry = options.store.store({
          content: text,
          tags: tagged ? [...(rawTags ?? []), UNCONFIRMED_NAME_TAG] : rawTags,
          sessionId: ctx.sessionId,
          workingDir: ctx.workingDir,
          source: "agent",
        });
        return compressToolResult({
          tool: "memory.notes.store",
          status: "ok",
          output:
            unconfirmed.length > 0
              ? `stored #${entry.id}, tagged ${UNCONFIRMED_NAME_TAG}: the user has not written the name ${unconfirmed.map((n) => `"${n}"`).join(", ")} in any conversation, so it is not their known name. Do not call the user by it; ask them if it matters.`
              : `stored #${entry.id}`,
          details: {
            id: entry.id,
            content: entry.content,
            tags: entry.tags,
            updatedAt: entry.updatedAt,
            stored: true,
            ...(unconfirmed.length > 0 ? { unconfirmedNames: unconfirmed } : {}),
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

/**
 * Names the note claims for the user that neither this session's user
 * messages nor any stored session's carry. A name only the stored
 * sessions can vouch for costs one scan, and only when the note names
 * the user at all.
 */
async function unconfirmedNames(
  text: string,
  ctx: ToolContext,
  source: GroundingConversationSource | undefined,
): Promise<string[]> {
  // Nothing to check against (a caller that wires neither): no verdict.
  if (ctx.userGroundingTexts === undefined && source === undefined) return [];
  const claimed = ungroundedClaimedNames(text, ctx.userGroundingTexts ?? []);
  if (claimed.length === 0 || source === undefined) return claimed;
  const out: string[] = [];
  for (const name of claimed) {
    if ((await nameGroundingAcrossSessions(name, source)) === "ungrounded") {
      out.push(name);
    }
  }
  return out;
}
