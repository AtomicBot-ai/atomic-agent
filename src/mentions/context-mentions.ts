/**
 * `@` mentions beyond whole files, expanded on send next to them
 * (ATO-2241 in the desktop; one implementation for the terminal and the
 * desktop since ATO-2472). mention-kinds.ts tells the words apart;
 * mention-git.ts, mention-url.ts, mention-local.ts and the problems
 * source read them. Every entry goes into the same `<mentioned-files>`
 * block as `@file` (mention-block.ts), under the same caps (entries per
 * message, bytes per entry, bytes per message), so the chat collapses it
 * to one line per mention and input history keeps the typed text only.
 *
 * A word that is a real file stays a file mention: `@diff` with a file
 * named `diff` in the folder inlines that file.
 *
 * Scope: ranges and folders pass the `@file` guard (inside the working
 * folder on the written and the real path); git runs with `--relative
 * -- .` in the working folder; `@problems` reports files inside it only;
 * the agent's own key files are never inlined.
 */

import { realpathSync } from "node:fs";

import {
  DEFAULT_MENTION_LIMITS,
  TRAILING_PUNCTUATION,
  mentionTokens,
  mentionedFiles,
  resolveMentionedFile,
  type IsProtectedPath,
  type MentionLimits,
} from "./expand-file-mentions.js";
import { appendMentionBlock, type MentionedFile } from "./mention-block.js";
import { diffArgs, logArgs, runGit, type GitOutput, type RunGit } from "./mention-git.js";
import { parseMentionKind, type MentionKind } from "./mention-kinds.js";
import { LocalSkip, folderListing, listFolder, readLineRange, resolveMentionedDir, type ListFolder } from "./mention-local.js";
import { formatProblems } from "./mention-problems.js";
import { UrlSkip, createFetchUrl, type FetchUrl } from "./mention-url.js";
import type { WorkspaceProblems } from "../tools/os/fs/lsp/index.js";

export interface ContextMentionDeps {
  runGit: RunGit;
  fetchUrl: FetchUrl;
  listFolder: ListFolder;
  /** The working folder's problems; absent reads as language servers off. */
  problems?: (workingDir: string) => Promise<WorkspaceProblems>;
  /** The agent's own key and trust files (`getStateSecretPaths`), by real path. */
  isProtected?: IsProtectedPath;
}

export const DEFAULT_CONTEXT_DEPS: ContextMentionDeps = {
  runGit,
  fetchUrl: createFetchUrl(),
  listFolder,
};

type Target = MentionKind | { kind: "folder"; dir: string };

/** What one `@word` reads, the word as shown, or `null` for prose and plain files. */
function targetOf(root: string, raw: string): { shown: string; target: Target } | null {
  const stripped = raw.replace(TRAILING_PUNCTUATION, "");
  if (stripped.length === 0) return null;
  if (resolveMentionedFile(root, raw) || resolveMentionedFile(root, stripped)) return null;
  const kind = parseMentionKind(stripped);
  if (kind) return { shown: stripped, target: kind };
  const dir = resolveMentionedDir(root, raw) ?? resolveMentionedDir(root, stripped);
  const shown = resolveMentionedDir(root, raw) ? raw : stripped;
  return dir ? { shown, target: { kind: "folder", dir } } : null;
}

/** Whether `text` has any `@word` this module would read (cheap, sync, no reads beyond stat). */
export function hasContextMentions(text: string, workingDir: string): boolean {
  const tokens = mentionTokens(text);
  if (tokens.length === 0) return false;
  let root: string;
  try {
    root = realpathSync(workingDir);
  } catch {
    return false;
  }
  return tokens.some((raw) => targetOf(root, raw) !== null);
}

function gitText(out: GitOutput, empty: string): { text: string; cut: boolean } {
  return out.text.trim().length === 0 ? { text: empty, cut: false } : out;
}

/** The text one target inlines (`cut`: the source itself was cut), or `null` when it is no mention. */
async function read(root: string, shown: string, target: Target, deps: ContextMentionDeps): Promise<{ text: string; cut: boolean } | null> {
  switch (target.kind) {
    case "diff":
      return gitText(await deps.runGit(root, diffArgs()), "No uncommitted changes to tracked files.\n");
    case "git":
      return gitText(await deps.runGit(root, logArgs(target.count)), "No commits touch this folder.\n");
    case "problems":
      return { text: formatProblems(deps.problems ? await deps.problems(root) : { state: "off" }), cut: false };
    case "range": {
      const text = readLineRange(root, target.path, target.start, target.end, deps.isProtected);
      return text === null ? null : { text, cut: false };
    }
    case "url":
      return deps.fetchUrl(target.url);
    case "folder":
      return { text: folderListing(shown, await deps.listFolder(target.dir)), cut: false };
  }
}

function reasonOf(err: unknown, target: Target): string {
  if (err instanceof UrlSkip || err instanceof LocalSkip) return err.message;
  if (target.kind === "diff" || target.kind === "git") return "not a git checkout, or git failed";
  if (target.kind === "problems") return "the language servers did not answer";
  return "could not be read";
}

/** `text` cut to `cap` bytes on a character boundary. */
function capBytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  return buf.subarray(0, cap).toString("utf8").replace(/�+$/, "");
}

/**
 * The entries for `text`'s non-file mentions, after `used` (what the plain
 * files already took) and within `limits`.
 */
export async function contextMentions(
  text: string,
  workingDir: string,
  used: { files: number; bytes: number },
  limits: MentionLimits = DEFAULT_MENTION_LIMITS,
  deps: ContextMentionDeps = DEFAULT_CONTEXT_DEPS,
): Promise<MentionedFile[]> {
  const tokens = mentionTokens(text);
  if (tokens.length === 0) return [];
  let root: string;
  try {
    root = realpathSync(workingDir);
  } catch {
    return [];
  }
  const out: MentionedFile[] = [];
  const seen = new Set<string>();
  let budget = limits.totalBytes - used.bytes;
  for (const raw of tokens) {
    if (used.files + out.length >= limits.files) break;
    const found = targetOf(root, raw);
    if (!found || seen.has(found.shown)) continue;
    seen.add(found.shown);
    const cap = Math.min(limits.fileBytes, budget);
    if (cap <= 0) {
      out.push({ path: found.shown, bytes: 0, content: "", skipped: "the message's file budget is used up" });
      continue;
    }
    let got: { text: string; cut: boolean } | null;
    try {
      got = await read(root, found.shown, found.target, deps);
    } catch (err) {
      out.push({ path: found.shown, bytes: 0, content: "", skipped: reasonOf(err, found.target) });
      continue;
    }
    if (got === null) continue;
    const bytes = Buffer.byteLength(got.text, "utf8");
    const content = capBytes(got.text, cap);
    const kept = Buffer.byteLength(content, "utf8");
    budget -= kept;
    out.push(kept < bytes || got.cut
      ? { path: found.shown, bytes, content, truncatedTo: kept }
      : { path: found.shown, bytes, content });
  }
  return out;
}

/** `text` with one block for its file mentions and its other mentions, or `text` unchanged. */
export async function expandMentions(
  text: string,
  workingDir: string,
  deps: ContextMentionDeps = DEFAULT_CONTEXT_DEPS,
  limits: MentionLimits = DEFAULT_MENTION_LIMITS,
): Promise<string> {
  const files = mentionedFiles(text, workingDir, limits, deps.isProtected);
  const bytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
  const extra = await contextMentions(text, workingDir, { files: files.length, bytes }, limits, deps);
  return appendMentionBlock(text, [...files, ...extra]);
}
