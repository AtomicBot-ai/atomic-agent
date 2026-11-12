import { parse as parseYaml } from "yaml";

/**
 * A named subagent profile (ATO-566): a role the planner hands a delegated
 * task to by name. A profile is a markdown file with YAML frontmatter, the
 * format Claude Code (`.claude/agents/*.md`), Goose and pi use:
 *
 *   ---
 *   name: review
 *   description: Reads a change and reports problems
 *   model: review          # optional: a fusion role, a model name, or inherit
 *   tools: os.fs.read, Grep # optional allowlist; absent = the worker default
 *   ---
 *   The system prompt for the worker.
 *
 * Unknown frontmatter keys (`color`, ...) are ignored so files written for
 * other agents load unchanged.
 */
export type AgentProfileSource = "builtin" | "user" | "project" | "plugin";

export interface AgentProfile {
  /** Lower-cased; `plugin:agent` for a plugin's profile. */
  name: string;
  description: string;
  /** The body: instructions the worker reads before its task. */
  prompt: string;
  /** As written; resolved against the run mode by the delegate. */
  model?: string;
  /**
   * The tool allowlist as written (our names, `prefix.*`, or Claude names).
   * Absent: the worker keeps its usual tools.
   */
  tools?: string[];
  source: AgentProfileSource;
  /** The file it came from; absent for a built-in. */
  file?: string;
}

/** Bounds a profile file: a brief, not a document. */
export const MAX_PROFILE_FILE_BYTES = 64 * 1024;
/** Bounds the prompt pasted into every worker brief that names the profile. */
export const MAX_PROFILE_PROMPT_CHARS = 16_000;
export const MAX_PROFILE_DESCRIPTION_CHARS = 1_000;
export const MAX_PROFILE_TOOLS = 64;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `Code-Reviewer` → `code-reviewer`; null when it is not a usable name. */
export function normaliseProfileName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return NAME_PATTERN.test(name) ? name : null;
}

export type ParsedProfileFile =
  | { ok: true; profile: Omit<AgentProfile, "source" | "file"> }
  | { ok: false; error: string };

function splitFrontmatter(text: string): { meta: string | null; body: string } | null {
  if (!text.startsWith("---\n")) return { meta: null, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const after = text.slice(end + 4);
  // The closing fence must end its line: `---x` is not a fence.
  if (after.length > 0 && !after.startsWith("\n")) return null;
  return { meta: text.slice(4, end), body: after.replace(/^\n+/, "") };
}

/**
 * Parse and validate one profile file. Never throws: a broken file is a
 * diagnostic for the operator, never a failed turn. `fallbackName` (the
 * file name without `.md`) is used when the frontmatter names nothing.
 */
export function parseAgentProfileFile(
  content: string,
  fallbackName: string,
): ParsedProfileFile {
  if (Buffer.byteLength(content) > MAX_PROFILE_FILE_BYTES) {
    return { ok: false, error: `larger than ${MAX_PROFILE_FILE_BYTES / 1024} KiB` };
  }
  const split = splitFrontmatter(content.replace(/\r\n/g, "\n"));
  if (split === null) return { ok: false, error: "frontmatter is not closed with ---" };
  let meta: Record<string, unknown> = {};
  if (split.meta !== null) {
    let parsed: unknown;
    try {
      parsed = parseYaml(split.meta);
    } catch (err) {
      return { ok: false, error: `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "frontmatter must be a mapping of keys" };
      }
      meta = parsed as Record<string, unknown>;
    }
  }
  const problems: string[] = [];

  const rawName = meta.name === undefined || meta.name === null ? fallbackName : meta.name;
  const name = typeof rawName === "string" ? normaliseProfileName(rawName) : null;
  if (name === null) {
    problems.push(`name must be 1-64 letters, digits, "-" or "_" (got ${JSON.stringify(rawName)})`);
  }

  let description = "";
  if (meta.description !== undefined && meta.description !== null) {
    if (typeof meta.description !== "string") problems.push("description must be text");
    else if (meta.description.length > MAX_PROFILE_DESCRIPTION_CHARS) {
      problems.push(`description is longer than ${MAX_PROFILE_DESCRIPTION_CHARS} chars`);
    } else description = meta.description.trim();
  }

  let model: string | undefined;
  if (meta.model !== undefined && meta.model !== null) {
    if (typeof meta.model !== "string" || meta.model.trim().length === 0) {
      problems.push("model must be a non-empty string");
    } else model = meta.model.trim();
  }

  let tools: string[] | undefined;
  if (meta.tools !== undefined && meta.tools !== null) {
    const list = typeof meta.tools === "string"
      ? meta.tools.split(",")
      : Array.isArray(meta.tools) ? meta.tools : null;
    if (list === null || list.some((t) => typeof t !== "string")) {
      problems.push("tools must be a list of tool names or one comma-separated string");
    } else {
      const cleaned = [...new Set((list as string[]).map((t) => t.trim()).filter(Boolean))];
      if (cleaned.length > MAX_PROFILE_TOOLS) problems.push(`tools has more than ${MAX_PROFILE_TOOLS} entries`);
      // An empty list is "no allowlist", like an absent key: a profile that
      // can call nothing at all cannot do a task.
      else if (cleaned.length > 0) tools = cleaned;
    }
  }

  const prompt = split.body.trim();
  if (prompt.length === 0) problems.push("the body (the profile's instructions) is empty");
  else if (prompt.length > MAX_PROFILE_PROMPT_CHARS) {
    problems.push(`the body is ${prompt.length} chars; at most ${MAX_PROFILE_PROMPT_CHARS}`);
  }

  if (problems.length > 0 || name === null) return { ok: false, error: problems.join("; ") };
  return {
    ok: true,
    profile: {
      name,
      description,
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(tools === undefined ? {} : { tools }),
    },
  };
}
