import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  ProfileStore,
  ProfileValidationError,
  type ProfileSetOptions,
} from "../../memory/profile-store.js";
import {
  isNameProfileKey,
  type NameGroundingStatus,
} from "../../memory/profile-name-keys.js";
import {
  nameGroundingAcrossSessions,
  type GroundingConversationSource,
} from "../../memory/name-grounding.js";
import { nameGroundingIn } from "../../memory/reflection/reflection-grounding.js";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";

export interface ProfileSetToolOptions {
  store: ProfileStore;
  /**
   * ATO-200. Every stored session's user messages
   * (`sessionGroundingSource`). A name the user gave in an earlier
   * session counts as theirs; without this only the current session's
   * messages (`ToolContext.userGroundingTexts`) do.
   */
  groundingSource?: GroundingConversationSource;
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
 *
 * ATO-200. A name-like key (`name`, `full_name`, …) is written only when
 * the user's own messages carry the name — this session's first, then
 * every stored one, so a name given last week still counts and a retry
 * is not refused for the wrong reason. A name no user message carries is
 * refused with an error that tells the model to ask; the model saw an
 * invented "Анна" in its profile and stored it again. Notes, profile
 * values and the assistant's replies never vouch for a name.
 */
export function buildProfileSetTool(
  options: ProfileSetToolOptions,
): ToolDefinition {
  return {
    name: "memory.profile.set",
    description:
      "Upsert a durable user profile fact (cross-session). Keys identify the fact, values hold short text. Optional: pinned (default true) — when false, the fact only renders into `### profile` if one of its `keywords` matches the current user message. Use pinned=false for rarely-needed context (deploy commands, env vars, per-feature preferences) to keep the default prompt small. A name (name, full_name, nickname, …) is saved only if the user wrote it themselves; never save a name you inferred or saw elsewhere.",
    readonly: false,
    async run(rawArgs, ctx) {
      const key = rawArgs.key;
      const value = rawArgs.value;
      try {
        const setOptions = parseSetOptions(rawArgs);
        if (
          typeof key === "string" &&
          typeof value === "string" &&
          isNameProfileKey(key.trim())
        ) {
          const verdict = await checkName(value, ctx, options.groundingSource);
          if (verdict === "ungrounded") {
            return compressToolResult({
              tool: "memory.profile.set",
              status: "error",
              output: `not saved: the user has not written the name "${truncatePreview(value, 60)}" in any conversation. Do not save it or call the user by it — ask the user for their name and save exactly what they write.`,
              details: {
                field: "value",
                reason: "name_not_written_by_user",
                key: key.trim(),
              },
            });
          }
          if (verdict !== null) setOptions.nameGrounding = verdict;
        }
        const fact = options.store.set(
          typeof key === "string" ? key : "",
          typeof value === "string" ? value : "",
          setOptions,
        );
        return compressToolResult({
          tool: "memory.profile.set",
          status: "ok",
          output: renderOkOutput(
            fact.key,
            fact.value,
            fact.pinned,
            fact.keywords,
          ),
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

/**
 * The name's verdict: this session's user messages first (cheap, and
 * the only place the turn being run lives — it is saved when the turn
 * ends), then every stored session. `null` when neither source is
 * wired: the row is written unchecked and the startup check decides.
 */
async function checkName(
  value: string,
  ctx: ToolContext,
  source: GroundingConversationSource | undefined,
): Promise<NameGroundingStatus | null> {
  const current =
    ctx.userGroundingTexts !== undefined
      ? nameGroundingIn(value, ctx.userGroundingTexts)
      : null;
  if (current === "grounded") return "grounded";
  if (source === undefined) return current;
  const stored = await nameGroundingAcrossSessions(value, source);
  if (stored === "grounded") return "grounded";
  return current === "unverifiable" || stored === "unverifiable"
    ? "unverifiable"
    : "ungrounded";
}

function parseSetOptions(rawArgs: Record<string, unknown>): ProfileSetOptions {
  const options: ProfileSetOptions = {};
  if (rawArgs.pinned !== undefined) {
    if (typeof rawArgs.pinned !== "boolean") {
      throw new ProfileValidationError("keywords", "pinned must be a boolean");
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
