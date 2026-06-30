/**
 * ClawHub source model. ClawHub (https://clawhub.ai) is the public
 * OpenClaw skill registry. Unlike a GitHub "tap", it is a proper
 * registry with a public read API, server-side relevance search, and a
 * built-in security scan verdict per skill version.
 *
 * Skills are addressed by `@owner/slug` (the canonical, owner-qualified
 * form ClawHub's own CLI uses) because a bare `slug` is NOT globally
 * unique — the registry returns `AMBIGUOUS_SKILL_SLUG` when two
 * publishers share one. A bare `slug` (owner unknown) is still accepted
 * for catalog-browse rows, which the read API does not annotate with an
 * owner; the download path resolves it by slug and surfaces a clear
 * error when the slug turns out to be ambiguous.
 */

export interface ClawHubSkillRef {
  /** Publisher handle, or null when only the slug is known. */
  owner: string | null;
  /** Skill slug (registry key within an owner). */
  slug: string;
}

export class ClawHubIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawHubIdentifierError";
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

/**
 * Parse a ClawHub identifier. Accepts the canonical `@owner/slug` form
 * and the owner-less bare `slug` form (used by catalog-browse rows).
 * Local paths, URLs, and GitHub `owner/repo` identifiers are rejected.
 */
export function parseClawHubIdentifier(raw: string): ClawHubSkillRef {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ClawHubIdentifierError("clawhub identifier is empty");
  }

  if (trimmed.startsWith("@")) {
    const segments = trimmed.slice(1).split("/").filter((s) => s.length > 0);
    if (segments.length !== 2) {
      throw new ClawHubIdentifierError(
        `expected @owner/slug, got: ${raw}`,
      );
    }
    const owner = segments[0]!;
    const slug = segments[1]!;
    if (!OWNER_RE.test(owner)) {
      throw new ClawHubIdentifierError(`invalid clawhub owner: ${owner}`);
    }
    if (!SLUG_RE.test(slug)) {
      throw new ClawHubIdentifierError(`invalid clawhub slug: ${slug}`);
    }
    return { owner, slug };
  }

  // Bare slug — owner unknown (catalog-browse rows lack it).
  if (trimmed.includes("/")) {
    throw new ClawHubIdentifierError(
      `not a clawhub identifier (expected @owner/slug or slug): ${raw}`,
    );
  }
  if (!SLUG_RE.test(trimmed)) {
    throw new ClawHubIdentifierError(`invalid clawhub slug: ${trimmed}`);
  }
  return { owner: null, slug: trimmed };
}

/**
 * `true` when `raw` is an explicit ClawHub identifier (`@owner/slug`).
 * Used by the CLI to route `skill install` to the ClawHub installer.
 * A bare slug is intentionally NOT matched here so a local directory
 * name (`skill install myskill`) is never hijacked into a registry
 * lookup — the TUI routes by an explicit `source` field instead.
 */
export function looksLikeClawHubIdentifier(raw: string): boolean {
  return raw.trim().startsWith("@");
}

/** Build the canonical `@owner/slug` identifier, or a bare slug. */
export function formatClawHubIdentifier(
  owner: string | null,
  slug: string,
): string {
  return owner ? `@${owner}/${slug}` : slug;
}
