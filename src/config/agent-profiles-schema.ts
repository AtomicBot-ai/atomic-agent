/**
 * Validation for `llm.runMode.agentProfiles` (ATO-1667): subagent
 * profiles written in `config.json` instead of as `agents/*.md` files.
 * Kept out of `config-schema.ts` and `llm-run-mode-config.ts`, like
 * `custom-models-schema.ts`, so the shared schema does not grow. Only
 * the shape is checked here; turning entries into profiles next to the
 * files is the loader's job (ATO-1668).
 *
 * An entry carries what a profile file can: the key is the name, and
 * the fields are the frontmatter plus `prompt` for the body. The name
 * rule and the limits are the file's own (`agent-profile.ts`), so a
 * profile can move between a file and the settings unchanged. Unknown
 * fields are ignored, as in `custom-models-schema.ts` and in a profile
 * file's frontmatter. A broken entry is skipped with a config notice,
 * as a broken profile file is only a diagnostic; the other entries load.
 */

import {
  MAX_PROFILE_DESCRIPTION_CHARS,
  MAX_PROFILE_PROMPT_CHARS,
  MAX_PROFILE_TOOLS,
  normaliseProfileName,
} from "../agent-profiles/agent-profile.js";
import { emitConfigNoticeOnce } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

/** One profile in the settings: the fields of an `agents/*.md` file. */
export type UserAgentProfileConfig = {
  /** What the profile is for, shown to the planner. At most 1,000 chars. */
  description?: string;
  /** The instructions the worker reads before its task (a file's body). At most 16,000 chars. */
  prompt: string;
  /** A fusion role (`plan`, `build`, `review`, `explore`, `utility`), a model name or provider id, or `inherit`. */
  model?: string;
  /**
   * Tool allowlist (our names, `prefix.*` or Claude Code names), a list or
   * one comma-separated string as in a profile file; read as a list.
   * Absent or empty: the worker keeps its usual tools.
   */
  tools?: string[];
};

/** Profiles keyed by name; the name follows the profile file rule. */
export type UserAgentProfilesConfig = Record<string, UserAgentProfileConfig>;

function parseAgentProfileEntry(raw: unknown, field: string): UserAgentProfileConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object");
  }
  const entry = raw as Record<string, unknown>;

  if (typeof entry.prompt !== "string" || entry.prompt.trim().length === 0) {
    throw new ConfigValidationError(`${field}.prompt`, "expected a non-empty string");
  }
  const prompt = entry.prompt.trim();
  if (prompt.length > MAX_PROFILE_PROMPT_CHARS) {
    throw new ConfigValidationError(
      `${field}.prompt`,
      `is ${prompt.length} chars; at most ${MAX_PROFILE_PROMPT_CHARS}`,
    );
  }
  const out: UserAgentProfileConfig = { prompt };

  if (entry.description !== undefined && entry.description !== null) {
    if (typeof entry.description !== "string") {
      throw new ConfigValidationError(`${field}.description`, "expected a string");
    }
    if (entry.description.length > MAX_PROFILE_DESCRIPTION_CHARS) {
      throw new ConfigValidationError(
        `${field}.description`,
        `longer than ${MAX_PROFILE_DESCRIPTION_CHARS} chars`,
      );
    }
    out.description = entry.description.trim();
  }

  if (entry.model !== undefined && entry.model !== null) {
    if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
      throw new ConfigValidationError(`${field}.model`, "expected a non-empty string");
    }
    out.model = entry.model.trim();
  }

  if (entry.tools !== undefined && entry.tools !== null) {
    // Split and trimmed exactly as `parseAgentProfileFile` reads frontmatter.
    const list = typeof entry.tools === "string"
      ? entry.tools.split(",")
      : Array.isArray(entry.tools) ? entry.tools : null;
    if (list === null || list.some((t) => typeof t !== "string")) {
      throw new ConfigValidationError(
        `${field}.tools`,
        "expected a list of tool names or one comma-separated string",
      );
    }
    const cleaned = [...new Set((list as string[]).map((t) => t.trim()).filter(Boolean))];
    if (cleaned.length > MAX_PROFILE_TOOLS) {
      throw new ConfigValidationError(`${field}.tools`, `more than ${MAX_PROFILE_TOOLS} entries`);
    }
    // An empty list is "no allowlist", as in a profile file.
    if (cleaned.length > 0) out.tools = cleaned;
  }

  return out;
}

/** One notice per broken entry and process; the entry is left out. */
function skipEntry(field: string, reason: string): void {
  emitConfigNoticeOnce(`[atomic-agent] ${field}: ${reason}; this profile is skipped`);
}

/**
 * Parse the `agentProfiles` map. Absent or `null` is no profiles
 * (`undefined`); an empty object stays empty. Names are lower-cased as
 * a file name is. An entry with a bad name, a name another key already
 * took after lower-casing, or an invalid field is skipped with a notice
 * naming its path. A node that is not an object stays a validation
 * error, as for `webhooks` and `fileTriggers`.
 */
export function parseAgentProfilesConfig(
  raw: unknown,
  field: string,
): UserAgentProfilesConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object keyed by profile name");
  }
  const out: UserAgentProfilesConfig = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = normaliseProfileName(key);
    if (name === null) {
      skipEntry(
        `${field}.${key}`,
        `profile name must be 1-64 letters, digits, "-" or "_", starting with a letter or digit (got ${JSON.stringify(key)})`,
      );
      continue;
    }
    if (Object.hasOwn(out, name)) {
      skipEntry(`${field}.${key}`, `duplicate profile name: ${name}`);
      continue;
    }
    try {
      out[name] = parseAgentProfileEntry(value, `${field}.${key}`);
    } catch (err) {
      if (!(err instanceof ConfigValidationError)) throw err;
      skipEntry(err.field, err.reason);
    }
  }
  return out;
}
