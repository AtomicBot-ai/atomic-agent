import fuzzysort from "fuzzysort";

/** Most rows the palette ranks; it shows a window of these. */
export const MAX_MENTION_RESULTS = 50;

/**
 * The paths that best match `query`, best first. An empty query lists
 * the shallowest paths first, which puts the project's top-level files
 * (README, package.json, src/...) where a person starts looking.
 */
export function rankMentionFiles(
  query: string,
  files: readonly string[],
  limit: number = MAX_MENTION_RESULTS,
): string[] {
  const q = query.trim();
  if (q.length === 0) {
    return [...files]
      .sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, limit);
  }
  return fuzzysort.go(q, files, { limit }).map((result) => result.target);
}

function depth(path: string): number {
  let n = 0;
  for (const ch of path) if (ch === "/") n += 1;
  return n;
}
