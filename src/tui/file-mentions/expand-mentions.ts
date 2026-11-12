/**
 * On submit: every `@path` that names a real file inside the working
 * directory is read and inlined under the message (mention-block.ts).
 *
 * The rules, in order of importance:
 *   - Nothing outside the working directory is ever read. The check is
 *     made twice: on the path as written (`@../x`, `@/etc/passwd`), and
 *     on the real path after symlinks, so a link inside the folder that
 *     points out of it is refused too.
 *   - A word that does not resolve to a file stays plain text and adds
 *     nothing: `@team`, `@src/` (a folder) and `@missing.ts` are prose.
 *   - Size is capped per file and per message, and a cut is stated in
 *     the message itself, so the model never mistakes a head for a file.
 *
 * Synchronous on purpose: it runs between Enter and the send, the reads
 * are bounded by the caps below, and an async step there would let two
 * quick submits overtake each other.
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { appendMentionBlock, type MentionedFile } from "./mention-block.js";

export interface MentionLimits {
  /** Most bytes inlined from one file. */
  fileBytes: number;
  /** Most bytes inlined across all files of one message. */
  totalBytes: number;
  /** Most files inlined from one message. */
  files: number;
}

export const DEFAULT_MENTION_LIMITS: MentionLimits = {
  fileBytes: 32 * 1024,
  totalBytes: 96 * 1024,
  files: 8,
};

const MENTION_TOKEN = /(^|[\s([{"'`])@([^\s@]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'`]+$/;

/** The distinct `@words` of `text`, in order, without the `@`. */
export function mentionTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const token = match[2];
    if (token) seen.add(token);
  }
  return [...seen];
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The real path of `token` when it is a file inside `root`, else `null`. */
export function resolveMentionedFile(root: string, token: string): string | null {
  const candidate = resolve(root, token);
  if (!inside(root, candidate)) return null;
  try {
    const real = realpathSync(candidate);
    if (!inside(root, real)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function readHead(path: string, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(max);
    const read = readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function readMentioned(
  shown: string,
  real: string,
  budget: number,
  limits: MentionLimits,
): MentionedFile {
  const bytes = statSync(real).size;
  const cap = Math.min(limits.fileBytes, budget);
  if (cap <= 0) return { path: shown, bytes, content: "", skipped: "the message's file budget is used up" };
  const head = readHead(real, Math.min(bytes, cap));
  if (head.includes(0)) return { path: shown, bytes, content: "", skipped: "binary file" };
  const content = head.toString("utf8");
  return head.length < bytes
    ? { path: shown, bytes, content, truncatedTo: head.length }
    : { path: shown, bytes, content };
}

/**
 * `text` with the block for its `@`-mentioned files appended, or `text`
 * unchanged when none of its `@words` is a file in `workingDir`.
 */
export function expandFileMentions(
  text: string,
  workingDir: string,
  limits: MentionLimits = DEFAULT_MENTION_LIMITS,
): string {
  const tokens = mentionTokens(text);
  if (tokens.length === 0) return text;
  let root: string;
  try {
    root = realpathSync(workingDir);
  } catch {
    return text;
  }
  const files: MentionedFile[] = [];
  const done = new Set<string>();
  let budget = limits.totalBytes;
  for (const raw of tokens) {
    if (files.length >= limits.files) break;
    const stripped = raw.replace(TRAILING_PUNCTUATION, "");
    const token = resolveMentionedFile(root, raw) ? raw : stripped;
    const real = token.length > 0 ? resolveMentionedFile(root, token) : null;
    if (!real || done.has(real)) continue;
    done.add(real);
    try {
      const file = readMentioned(token, real, budget, limits);
      budget -= Buffer.byteLength(file.content, "utf8");
      files.push(file);
    } catch {
      // Vanished or unreadable between the check and the read: the word
      // stays prose, exactly like a path that never existed.
    }
  }
  return appendMentionBlock(text, files);
}
