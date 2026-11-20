/**
 * ATO-1593 / ATO-1595 — `@file` mentions in the desktop composer, the
 * main-process half. Ported from the terminal app (src/tui/file-mentions/
 * on main: file-index.ts, rank-mention-files.ts, expand-mentions.ts,
 * mention-block.ts, mention-query.ts) so both apps list, rank and inline
 * files the same way and the model sees the same block from either.
 *
 * No electron import: file-mentions-ipc.ts holds the wiring, and the tests
 * load this file from out/main as it is.
 *
 *   listing   the chat folder's files as relative paths. A git checkout
 *             answers through `git ls-files` (tracked plus untracked, minus
 *             .gitignore); anywhere else a breadth-first walk that skips
 *             dependency and build folders. Capped at 20 000 paths and a
 *             200 ms budget, cached 15 s per folder.
 *   ranking   fuzzysort over the list; an empty query gives the shallowest
 *             paths first.
 *   expanding on send: every `@path` that is a real file inside the chat
 *             folder is read and appended under the message in a
 *             `<mentioned-files>` block. Nothing outside the folder is ever
 *             read: the check runs on the path as written and again on the
 *             real path after symlinks.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import fuzzysort from "fuzzysort";

// ---------------------------------------------------------------- listing

export interface FileIndexLimits {
  /** Most paths kept. */
  maxFiles: number;
  /** Time budget for one listing, in milliseconds. */
  budgetMs: number;
  /** A list younger than this is reused as is. */
  freshMs: number;
}

export const DEFAULT_FILE_INDEX_LIMITS: FileIndexLimits = {
  maxFiles: 20_000,
  budgetMs: 200,
  freshMs: 15_000,
};

/** Folder names the walk never enters. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".idea",
  ".Trash", "Library", "vendor",
]);

export type ListFiles = (root: string, limits: FileIndexLimits) => Promise<string[]>;

/** `git ls-files` (execFile, no shell); rejects outside a repository or past its timeout. */
export function listGitFiles(root: string, limits: FileIndexLimits): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      // Git gets more than the walk's budget: in a big checkout it is
      // still the faster and more correct of the two.
      { cwd: root, timeout: limits.budgetMs * 10, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return fail(error);
        const paths = String(stdout).split("\0").filter((p) => p.length > 0);
        done(paths.slice(0, limits.maxFiles));
      },
    );
  });
}

/** Breadth-first walk of `root`, bounded by the file cap and the clock. */
export async function walkFiles(
  root: string,
  limits: FileIndexLimits,
  now: () => number = Date.now,
): Promise<string[]> {
  const deadline = now() + limits.budgetMs;
  const out: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && out.length < limits.maxFiles && now() < deadline) {
    const dir = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir.length > 0 ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= limits.maxFiles) break;
      }
    }
  }
  return out;
}

async function listDefault(root: string, limits: FileIndexLimits): Promise<string[]> {
  try {
    return await listGitFiles(root, limits);
  } catch {
    return walkFiles(root, limits);
  }
}

export interface MentionFileIndex {
  /** The cached list for `root`, refreshed when stale. */
  list(root: string): Promise<readonly string[]>;
}

interface IndexEntry {
  files: readonly string[];
  at: number;
  /** A listing has completed at least once. */
  loaded: boolean;
  pending: Promise<readonly string[]> | null;
}

export function createMentionFileIndex(
  options: { limits?: FileIndexLimits; listFiles?: ListFiles; now?: () => number } = {},
): MentionFileIndex {
  const limits = options.limits ?? DEFAULT_FILE_INDEX_LIMITS;
  const listFiles = options.listFiles ?? listDefault;
  const now = options.now ?? Date.now;
  const entries = new Map<string, IndexEntry>();

  const refresh = (root: string, entry: IndexEntry): Promise<readonly string[]> => {
    if (entry.pending) return entry.pending;
    entry.pending = listFiles(root, limits)
      .catch((): string[] => [])
      .then((listed) => {
        // A mention ends at whitespace, so a path with a space in it
        // could be picked but never sent; it is left out of the list.
        const files = listed.filter((p) => !/\s/.test(p));
        entry.files = files;
        entry.at = now();
        entry.loaded = true;
        entry.pending = null;
        return files;
      });
    return entry.pending;
  };

  return {
    list(root) {
      let entry = entries.get(root);
      if (!entry) {
        entry = { files: [], at: 0, loaded: false, pending: null };
        entries.set(root, entry);
        return refresh(root, entry);
      }
      // Stale but present: answer with what we have, refresh behind it.
      if (now() - entry.at >= limits.freshMs) void refresh(root, entry);
      return !entry.loaded && entry.pending ? entry.pending : Promise.resolve(entry.files);
    },
  };
}

// ---------------------------------------------------------------- ranking

/** Most rows the palette gets. */
export const MAX_MENTION_RESULTS = 50;

/**
 * The paths that best match `query`, best first. An empty query lists
 * the shallowest paths first, which puts the project's top-level files
 * where a person starts looking.
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

/**
 * The folder mentions are looked up in, or `null` when there is none to
 * use: a remote agent's folder is on another computer, so nothing on this
 * one is listed or read for it.
 */
export function mentionFolder(remote: boolean, dir: string | null | undefined): string | null {
  if (remote) return null;
  return typeof dir === "string" && dir.length > 0 ? dir : null;
}

/** `mentions:search` answered from `index` for `folder` (`null` → no paths). */
export async function searchMentions(
  index: MentionFileIndex,
  folder: string | null,
  query: string,
): Promise<{ ok: true; paths: string[] }> {
  if (!folder) return { ok: true, paths: [] };
  const files = await index.list(folder);
  return { ok: true, paths: rankMentionFiles(query, files, MAX_MENTION_RESULTS) };
}

// ---------------------------------------------------------------- the block

export const MENTION_BLOCK_OPEN = "<mentioned-files>";
export const MENTION_BLOCK_CLOSE = "</mentioned-files>";
const INTRO = "Files the user referenced with @, read from the working directory:";
const SEPARATOR = `\n\n${MENTION_BLOCK_OPEN}\n${INTRO}\n`;

export interface MentionedFile {
  /** The path as the user wrote it, relative to the working directory. */
  path: string;
  /** Size of the whole file on disk. */
  bytes: number;
  /** The text inlined into the message (possibly cut). */
  content: string;
  /** Set when `content` is only the head of the file. */
  truncatedTo?: number;
  /** Set when the file was not inlined at all (binary, over budget). */
  skipped?: string;
}

/** Same rounding as the attachments block, so both read alike. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One summary line: `src/app.ts (3 KB)`, with any cut said plainly. */
export function describeMentionedFile(file: MentionedFile): string {
  const size = formatBytes(file.bytes);
  if (file.skipped !== undefined) return `${file.path} (${size}, not inlined: ${file.skipped})`;
  if (file.truncatedTo !== undefined) {
    return `${file.path} (${size}, truncated to the first ${formatBytes(file.truncatedTo)})`;
  }
  return `${file.path} (${size})`;
}

function fileSection(file: MentionedFile): string {
  if (file.skipped !== undefined) return "";
  const note =
    file.truncatedTo !== undefined
      ? `\n[truncated: showing the first ${formatBytes(file.truncatedTo)} of ${formatBytes(file.bytes)}; read the file itself for the rest]`
      : "";
  const body = file.content.endsWith("\n") ? file.content : `${file.content}\n`;
  return `\n<file path=${JSON.stringify(file.path)}>\n${body}</file>${note}\n`;
}

/** `text` followed by the block for `files`; `text` alone when empty. */
export function appendMentionBlock(text: string, files: readonly MentionedFile[]): string {
  if (files.length === 0) return text;
  const summary = files.map((f) => `- ${describeMentionedFile(f)}`).join("\n");
  const sections = files.map(fileSection).join("");
  return `${text}${SEPARATOR}${summary}\n${sections}${MENTION_BLOCK_CLOSE}`;
}

// ---------------------------------------------------------------- expanding

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

/** A NUL byte in this much of the head marks a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

// A mention starts the text or follows whitespace or an opening bracket or
// quote, so `me@site.com` is never one.
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

/**
 * The real path of `token` when it is a file inside `root` (itself a real
 * path), else `null`. `../x`, absolute paths, symlinks that lead out of
 * `root`, folders and missing files all answer `null`.
 */
export function resolveMentionedFile(root: string, token: string): string | null {
  if (isAbsolute(token)) return null;
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

function readMentioned(shown: string, real: string, budget: number, limits: MentionLimits): MentionedFile {
  const bytes = statSync(real).size;
  const cap = Math.min(limits.fileBytes, budget);
  if (cap <= 0) return { path: shown, bytes, content: "", skipped: "the message's file budget is used up" };
  const head = readHead(real, Math.min(bytes, cap));
  if (head.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { path: shown, bytes, content: "", skipped: "binary file" };
  }
  const content = head.toString("utf8");
  return head.length < bytes
    ? { path: shown, bytes, content, truncatedTo: head.length }
    : { path: shown, bytes, content };
}

/**
 * `text` with the block for its `@`-mentioned files appended, or `text`
 * unchanged when none of its `@words` is a file in `workingDir`.
 * Synchronous: the reads are bounded by the caps, and the send waits on it.
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

/**
 * The turn's messages with the LAST one expanded when it is the user's;
 * the history is left as it was sent before. `folder` `null` (a remote
 * agent, no folder) leaves every message as it is.
 */
export function expandLastUserMessage<T extends { role: string; content: string }>(
  messages: readonly T[],
  folder: string | null,
  limits: MentionLimits = DEFAULT_MENTION_LIMITS,
): T[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (!folder || !last || last.role !== "user") return out;
  const content = expandFileMentions(last.content, folder, limits);
  if (content !== last.content) out[out.length - 1] = { ...last, content };
  return out;
}
