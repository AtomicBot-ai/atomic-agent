/**
 * ATO-2241: the `@` words that are not plain file paths, told apart.
 * Pure parsing, no file system: context-mentions.ts decides what each one
 * reads, and file-mentions.ts still owns `@path` for a real file.
 *
 *   @diff                  uncommitted changes (Cursor's @Git "diff of working state")
 *   @git:N                 the last N commits, 1 to MAX_GIT_COMMITS
 *   @src/a.ts:10-40        lines 10 to 40 of a file (also `:10`, `#L10-40`, `#L10-L40`,
 *                          `#L10`: Claude Code's @file#L10-40)
 *   @https://host/page     a web page, http(s) only (Cursor's @Web / @Link)
 *
 * A folder (`@src/`) is recognised by the file system, not here.
 */

export const MAX_GIT_COMMITS = 20;

export type MentionKind =
  | { kind: "diff" }
  | { kind: "git"; count: number }
  | { kind: "range"; path: string; start: number; end: number }
  | { kind: "url"; url: string };

const GIT = /^git:(\d{1,4})$/;
const COLON_RANGE = /^(.+?):(\d{1,7})(?:-(\d{1,7}))?$/;
const HASH_RANGE = /^(.+?)#L(\d{1,7})(?:-L?(\d{1,7}))?$/;
const URL_START = /^https?:\/\//i;

/** What `token` (an `@word` without the `@`, punctuation already cut) asks for, or `null`. */
export function parseMentionKind(token: string): MentionKind | null {
  if (token === "diff") return { kind: "diff" };
  const git = GIT.exec(token);
  if (git) {
    const n = Number(git[1]);
    return n >= 1 ? { kind: "git", count: Math.min(n, MAX_GIT_COMMITS) } : null;
  }
  if (URL_START.test(token)) return parseUrl(token);
  const range = COLON_RANGE.exec(token) ?? HASH_RANGE.exec(token);
  if (range && range[1] && range[2]) {
    const start = Number(range[2]);
    const end = range[3] !== undefined ? Number(range[3]) : start;
    if (start < 1 || end < start) return null;
    return { kind: "range", path: range[1], start, end };
  }
  return null;
}

function parseUrl(token: string): MentionKind | null {
  try {
    const url = new URL(token);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return { kind: "url", url: url.href };
  } catch {
    return null;
  }
}

/** Rows the `@` palette puts above the files for `query` (prefix of a keyword, or a typed kind). */
export function contextSuggestions(query: string): string[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const kind = parseMentionKind(q);
  // A typed range, URL or `git:N` stays as typed: picking the row must not
  // swap it for a bare file path.
  if (kind && kind.kind !== "diff") return [kind.kind === "git" ? `git:${kind.count}` : q];
  if (q.length > 1 && q.endsWith("/")) return [q];
  return ["diff", "git:5"].filter((word) => word.startsWith(q.toLowerCase()));
}
