/**
 * Skill hub source model. A "tap" is a GitHub repository that hosts one
 * or more SKILL.md skills (the Hermes naming). The hub never runs a
 * server of its own — it resolves skills directly from GitHub, so the
 * existing community stores (openai/skills, anthropics/skills, etc.)
 * install without a registry signup.
 */

export interface SkillTap {
  /** GitHub repository in `owner/repo` form. */
  repo: string;
  /**
   * Subpath within the repo to scan for skills, no leading/trailing
   * slash. Empty string scans the whole tree for any `SKILL.md`.
   */
  path: string;
}

/**
 * Default browsable taps, mirroring the Hermes skills hub defaults.
 * Each is scanned by tree-walk for any `SKILL.md` so repo layout
 * differences (top-level dirs vs a `skills/` subtree) do not matter.
 */
export const DEFAULT_TAPS: readonly SkillTap[] = [
  { repo: "anthropics/skills", path: "" },
  { repo: "openai/skills", path: "" },
  { repo: "vercel-labs/agent-skills", path: "" },
];

export interface SkillIdentifier {
  owner: string;
  repo: string;
  /**
   * Path to the skill directory within the repo (no leading/trailing
   * slash). Empty string means the skill's `SKILL.md` is at the repo
   * root.
   */
  path: string;
  /** Optional git ref (branch / tag / commit sha). */
  ref?: string;
}

export class SkillIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillIdentifierError";
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;

/**
 * Parse a hub identifier of the form `owner/repo[/path/to/skill][@ref]`.
 *
 * Examples:
 *   anthropics/skills/pdf            → { owner, repo: skills, path: pdf }
 *   openai/skills                    → { owner: openai, repo: skills, path: "" }
 *   owner/repo/a/b@v1.2.0            → { ..., path: "a/b", ref: "v1.2.0" }
 *
 * Local paths (`./x`, `/x`, `~/x`) and URLs are rejected — those are
 * handled by the local installer / future source kinds.
 */
export function parseSkillIdentifier(raw: string): SkillIdentifier {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new SkillIdentifierError("skill identifier is empty");
  }
  if (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  ) {
    throw new SkillIdentifierError(
      `not a hub identifier (expected owner/repo[/path][@ref]): ${raw}`,
    );
  }

  let ref: string | undefined;
  let body = trimmed;
  const atIndex = trimmed.indexOf("@");
  if (atIndex !== -1) {
    ref = trimmed.slice(atIndex + 1).trim();
    body = trimmed.slice(0, atIndex).trim();
    if (!REF_RE.test(ref)) {
      throw new SkillIdentifierError(`invalid git ref: ${ref}`);
    }
  }

  const segments = body.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new SkillIdentifierError(
      `expected at least owner/repo, got: ${raw}`,
    );
  }
  const owner = segments[0]!;
  const repo = segments[1]!;
  const rest = segments.slice(2);
  if (!OWNER_RE.test(owner)) {
    throw new SkillIdentifierError(`invalid GitHub owner: ${owner}`);
  }
  if (!REPO_RE.test(repo)) {
    throw new SkillIdentifierError(`invalid GitHub repo: ${repo}`);
  }
  for (const seg of rest) {
    if (!PATH_SEGMENT_RE.test(seg)) {
      throw new SkillIdentifierError(`invalid path segment: ${seg}`);
    }
  }

  const identifier: SkillIdentifier = {
    owner,
    repo,
    path: rest.join("/"),
  };
  if (ref) identifier.ref = ref;
  return identifier;
}

/**
 * `true` when `raw` looks like a hub identifier rather than a local
 * directory path or a URL. Used by the CLI to route `skill install`.
 */
export function looksLikeHubIdentifier(raw: string): boolean {
  try {
    parseSkillIdentifier(raw);
    return true;
  } catch {
    return false;
  }
}

/** Parse a `owner/repo` tap repo string into its parts. */
export function parseTapRepo(repo: string): { owner: string; repo: string } {
  const segments = repo.split("/").filter((s) => s.length > 0);
  if (segments.length !== 2) {
    throw new SkillIdentifierError(
      `tap repo must be owner/repo, got: ${repo}`,
    );
  }
  const owner = segments[0]!;
  const name = segments[1]!;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name)) {
    throw new SkillIdentifierError(`invalid tap repo: ${repo}`);
  }
  return { owner, repo: name };
}

/** Build the canonical identifier string for a discovered skill. */
export function formatSkillIdentifier(
  owner: string,
  repo: string,
  dir: string,
): string {
  return dir.length > 0 ? `${owner}/${repo}/${dir}` : `${owner}/${repo}`;
}
