import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { PreviewOutcome } from "./fs-patch-preview.js";

/**
 * The `apply_patch` envelope format (Codex CLI, opencode and the models
 * trained on them), written from the format's public description:
 *
 *     *** Begin Patch
 *     *** Add File: path          lines follow, each starting with `+`
 *     *** Delete File: path
 *     *** Update File: path
 *     *** Move to: new/path       optional, right after Update File
 *     @@ optional context line    starts a hunk; the first hunk may omit it
 *      context / -removed / +added
 *     *** End of File             optional, anchors the hunk to the file end
 *     *** End Patch
 *
 * Hunks carry no line numbers: each one is found by its context and
 * removed lines, searched forward from where the previous hunk ended,
 * strictest comparison first (exact, then trailing whitespace, then both
 * ends, then typographic punctuation folded). Parsing is pure; planning
 * reads the targets but never writes. `os.fs.patch` owns approval and
 * the writes.
 */

export const CODEX_BEGIN = "*** Begin Patch";
export const CODEX_END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export interface CodexChunk {
  /** The `@@ …` line's text, searched for before the hunk; null for a bare `@@`. */
  context: string | null;
  oldLines: string[];
  newLines: string[];
  /** `*** End of File` closed the hunk: it should match at the end of the file. */
  endOfFile: boolean;
  added: number;
  removed: number;
}

export type CodexFileOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: CodexChunk[] };

export class CodexPatchParseError extends Error {}

/** Does this text use the `*** Begin Patch` envelope (heredoc wrapper allowed)? */
export function looksLikeCodexPatch(text: string): boolean {
  const lines = unwrap(text.split(/\r?\n/));
  return lines.length > 0 && lines[0]!.trim() === CODEX_BEGIN;
}

/** Parse the whole envelope; throws `CodexPatchParseError` naming the line. */
export function parseCodexPatch(text: string): CodexFileOp[] {
  const all = text.split(/\r?\n/);
  const lines = unwrap(all);
  // Line numbers in messages count from the first line of `text`.
  const offset = Math.max(lines.length > 0 ? all.indexOf(lines[0]!) : 0, 0) + 1;
  const fail = (index: number, message: string): never => {
    throw new CodexPatchParseError(`line ${index + offset}: ${message}`);
  };
  if (lines.length === 0 || lines[0]!.trim() !== CODEX_BEGIN) {
    fail(0, `the patch must start with "${CODEX_BEGIN}"`);
  }
  if (lines.length < 2 || lines[lines.length - 1]!.trim() !== CODEX_END) {
    fail(Math.max(lines.length - 1, 0), `the patch must end with "${CODEX_END}"`);
  }

  const ops: CodexFileOp[] = [];
  const last = lines.length - 1;
  let i = 1;
  while (i < last) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }
    if (trimmed.startsWith(ADD.trimEnd())) {
      const path = headerPath(trimmed, ADD, i, fail);
      i++;
      const body: string[] = [];
      while (i < last && lines[i]!.startsWith("+")) {
        body.push(lines[i]!.slice(1));
        i++;
      }
      ops.push({ kind: "add", path, lines: body });
      continue;
    }
    if (trimmed.startsWith(DELETE.trimEnd())) {
      ops.push({ kind: "delete", path: headerPath(trimmed, DELETE, i, fail) });
      i++;
      continue;
    }
    if (trimmed.startsWith(UPDATE.trimEnd())) {
      const path = headerPath(trimmed, UPDATE, i, fail);
      const headerIndex = i;
      i++;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.trim().startsWith(MOVE.trimEnd())) {
        moveTo = headerPath(lines[i]!.trim(), MOVE, i, fail);
        i++;
      }
      const parsed = parseChunks(lines, i, last, path, fail);
      i = parsed.next;
      if (parsed.chunks.length === 0) {
        fail(headerIndex, `"${UPDATE}${path}" has no hunks`);
      }
      ops.push(
        moveTo === undefined
          ? { kind: "update", path, chunks: parsed.chunks }
          : { kind: "update", path, moveTo, chunks: parsed.chunks },
      );
      continue;
    }
    fail(
      i,
      `expected "${ADD}", "${DELETE}" or "${UPDATE}", got ${JSON.stringify(clip(line))}` +
        (ops[ops.length - 1]?.kind === "add"
          ? " (every line of an added file starts with '+')"
          : ""),
    );
  }
  if (ops.length === 0) fail(0, "the patch changes no files");
  return ops;
}

function parseChunks(
  lines: readonly string[],
  start: number,
  last: number,
  path: string,
  fail: (index: number, message: string) => never,
): { chunks: CodexChunk[]; next: number } {
  const chunks: CodexChunk[] = [];
  let current: CodexChunk | null = null;
  let closed = false;
  let i = start;
  const open = (context: string | null): CodexChunk => {
    const chunk: CodexChunk = {
      context,
      oldLines: [],
      newLines: [],
      endOfFile: false,
      added: 0,
      removed: 0,
    };
    chunks.push(chunk);
    closed = false;
    return chunk;
  };
  while (i < last && !isFileHeader(lines[i]!)) {
    const raw = lines[i]!;
    if (raw.trim() === END_OF_FILE) {
      if (current === null || current.oldLines.length + current.newLines.length === 0) {
        fail(i, `"${END_OF_FILE}" must close a hunk with lines in it`);
      }
      current!.endOfFile = true;
      current = null;
      closed = true;
      i++;
      continue;
    }
    if (raw.startsWith("@@")) {
      if (current !== null && current.oldLines.length + current.newLines.length === 0) {
        fail(i, `empty hunk in "${path}" (an "@@" line with no lines after it)`);
      }
      const context = raw.slice(2).trim();
      current = open(context === "" ? null : context);
      i++;
      continue;
    }
    // A blank line with only blank lines before the next file header or
    // the end separates operations; anywhere else it is an empty context
    // line whose leading space was lost.
    if (raw === "" && onlyBlankUntilHeader(lines, i, last)) {
      i++;
      continue;
    }
    const mark = raw === "" ? " " : raw[0];
    if (mark !== " " && mark !== "+" && mark !== "-") {
      fail(
        i,
        `unexpected line in a hunk of "${path}": ${JSON.stringify(clip(raw))} (hunk lines start with ' ', '+' or '-', a new hunk with "@@")`,
      );
    }
    if (current === null) {
      if (closed) {
        fail(i, `a hunk after "${END_OF_FILE}" in "${path}" must start with "@@"`);
      }
      current = open(null);
    }
    const text = raw.slice(1);
    if (mark === " ") {
      current.oldLines.push(text);
      current.newLines.push(text);
    } else if (mark === "-") {
      current.oldLines.push(text);
      current.removed++;
    } else {
      current.newLines.push(text);
      current.added++;
    }
    i++;
  }
  if (current !== null && current.oldLines.length + current.newLines.length === 0) {
    fail(i - 1, `empty hunk in "${path}" (an "@@" line with no lines after it)`);
  }
  return { chunks, next: i };
}

function isFileHeader(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith(ADD.trimEnd()) ||
    t.startsWith(DELETE.trimEnd()) ||
    t.startsWith(UPDATE.trimEnd())
  );
}

function onlyBlankUntilHeader(lines: readonly string[], from: number, last: number): boolean {
  for (let j = from; j < last; j++) {
    const line = lines[j]!;
    if (isFileHeader(line)) return true;
    if (line.trim() !== "") return false;
  }
  return true;
}

function headerPath(
  trimmed: string,
  prefix: string,
  index: number,
  fail: (index: number, message: string) => never,
): string {
  const path = trimmed.slice(prefix.trimEnd().length).trim();
  if (path === "") fail(index, `"${prefix.trim()}" needs a path`);
  return path;
}

/** Drop surrounding blank lines and a `<<'EOF'` … `EOF` heredoc wrapper a model copied from a shell call. */
function unwrap(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  const first = lines[start]?.trim() ?? "";
  const heredoc = /^(?:apply_patch\s+)?<<\s*(['"]?)(\w+)\1$/.exec(first);
  if (heredoc !== null && end - start >= 2 && lines[end - 1]!.trim() === heredoc[2]) {
    start++;
    end--;
    while (start < end && lines[start]!.trim() === "") start++;
    while (end > start && lines[end - 1]!.trim() === "") end--;
  }
  return lines.slice(start, end);
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// ---------------------------------------------------------------------------
// Applying hunks to text

export type ChunkApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Apply an Update File's hunks to `original`. Line endings follow the
 * file (CRLF stays CRLF) and so does a missing final newline. A hunk
 * that does not match fails the whole file: nothing is half-applied.
 */
export function applyCodexChunks(
  original: string,
  chunks: readonly CodexChunk[],
): ChunkApplyResult {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = original.length === 0 || original.endsWith("\n");
  const lines =
    original.length === 0
      ? []
      : original
          .split("\n")
          .map((l) => (eol === "\r\n" && l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === "" && finalNewline) lines.pop();

  const replacements: Array<{ at: number; remove: number; insert: string[] }> = [];
  let cursor = 0;
  for (let n = 0; n < chunks.length; n++) {
    const chunk = chunks[n]!;
    const label = `hunk ${n + 1}`;
    if (chunk.context !== null) {
      const at = seekSequence(lines, [chunk.context], cursor, false);
      if (at < 0) {
        return {
          ok: false,
          reason: `${label}: the "@@ ${clip(chunk.context)}" line was not found${cursor > 0 ? " after the previous hunk" : ""}`,
        };
      }
      cursor = at + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Pure addition: right after the `@@` line when one was given,
      // otherwise at the end of the file.
      const at = chunk.context !== null && !chunk.endOfFile ? cursor : lines.length;
      replacements.push({ at, remove: 0, insert: chunk.newLines });
      continue;
    }
    let pattern = chunk.oldLines;
    let insert = chunk.newLines;
    let at = seekSequence(lines, pattern, cursor, chunk.endOfFile);
    if (at < 0 && pattern[pattern.length - 1] === "") {
      // A trailing empty context line is often the file's final newline.
      pattern = pattern.slice(0, -1);
      if (insert[insert.length - 1] === "") insert = insert.slice(0, -1);
      at = pattern.length === 0 ? -1 : seekSequence(lines, pattern, cursor, chunk.endOfFile);
    }
    if (at < 0) {
      return {
        ok: false,
        reason: `${label}: these lines were not found${cursor > 0 ? " after the previous hunk" : ""}: ${JSON.stringify(clip(chunk.oldLines.slice(0, 3).join("\n")))}`,
      };
    }
    replacements.push({ at, remove: pattern.length, insert });
    cursor = at + pattern.length;
  }

  // Later positions first, so earlier indices stay valid; equal positions
  // in reverse order, so two insertions at one spot keep the patch order.
  const ordered = replacements
    .map((r, index) => ({ ...r, index }))
    .sort((a, b) => b.at - a.at || b.index - a.index);
  const result = [...lines];
  for (const r of ordered) result.splice(r.at, r.remove, ...r.insert);
  const body = result.join(eol);
  return {
    ok: true,
    content: result.length > 0 && finalNewline ? body + eol : body,
  };
}

/**
 * Index where `pattern` starts in `lines` at or after `start`, or -1.
 * Tries each comparison over the whole range before relaxing to the
 * next. With `eof`, the end of the file is tried first.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
): number {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return -1;
  const lastStart = lines.length - pattern.length;
  const comparers: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => foldPunctuation(a) === foldPunctuation(b),
  ];
  const matchesAt = (i: number, same: (a: string, b: string) => boolean): boolean => {
    for (let k = 0; k < pattern.length; k++) {
      if (!same(lines[i + k]!, pattern[k]!)) return false;
    }
    return true;
  };
  for (const same of comparers) {
    if (eof && lastStart >= start && matchesAt(lastStart, same)) return lastStart;
    for (let i = start; i <= lastStart; i++) {
      if (matchesAt(i, same)) return i;
    }
  }
  return -1;
}

function foldPunctuation(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Planning against the disk (reads only)

export interface CodexPlannedFile {
  outcome: PreviewOutcome;
  /** The file's content after the patch; null when the patch removes it. */
  after: string | null;
}

type TargetState =
  | { kind: "missing" }
  | { kind: "file"; content: string }
  | { kind: "other"; reason: string };

async function readTarget(absolute: string): Promise<TargetState> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { kind: "other", reason: "target is not a regular file" };
    return { kind: "file", content: await readFile(absolute, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "other", reason: `cannot read target: ${(err as Error).message}` };
  }
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * Dry-run every operation against the disk. Each file gets an outcome
 * (applied or the reason it cannot be); a move yields two: the new path
 * and the removed old one. A path named twice fails both mentions.
 */
export async function planCodexPatch(
  ops: readonly CodexFileOp[],
  rootDir: string,
): Promise<CodexPlannedFile[]> {
  const resolveTarget = (p: string): string => (isAbsolute(p) ? p : resolve(rootDir, p));
  const plans: CodexPlannedFile[] = [];
  for (const op of ops) {
    const absolute = resolveTarget(op.path);
    const target = await readTarget(absolute);
    const failed = (reason: string, added = 0, removed = 0): CodexPlannedFile => ({
      outcome: {
        path: op.path,
        absolute,
        applied: false,
        reason,
        addedLines: added,
        removedLines: removed,
        existed: target.kind !== "missing",
        ...(target.kind === "file" ? { originalContent: target.content } : {}),
        action: op.kind,
      },
      after: null,
    });

    if (op.kind === "add") {
      if (target.kind !== "missing") {
        plans.push(failed("file already exists (use *** Update File to change it)", op.lines.length));
        continue;
      }
      const after = op.lines.length > 0 ? `${op.lines.join("\n")}\n` : "";
      plans.push({
        outcome: {
          path: op.path,
          absolute,
          applied: true,
          addedLines: op.lines.length,
          removedLines: 0,
          originalContent: "",
          existed: false,
          action: "add",
        },
        after,
      });
      continue;
    }

    if (target.kind === "missing") {
      plans.push(failed("file does not exist"));
      continue;
    }
    if (target.kind === "other") {
      plans.push(failed(target.reason));
      continue;
    }

    if (op.kind === "delete") {
      plans.push({
        outcome: {
          path: op.path,
          absolute,
          applied: true,
          addedLines: 0,
          removedLines: countTextLines(target.content),
          originalContent: target.content,
          existed: true,
          action: "delete",
        },
        after: null,
      });
      continue;
    }

    const added = op.chunks.reduce((sum, c) => sum + c.added, 0);
    const removed = op.chunks.reduce((sum, c) => sum + c.removed, 0);
    const applied = applyCodexChunks(target.content, op.chunks);
    if (!applied.ok) {
      plans.push(failed(applied.reason, added, removed));
      continue;
    }
    if (op.moveTo === undefined || resolveTarget(op.moveTo) === absolute) {
      plans.push({
        outcome: {
          path: op.path,
          absolute,
          applied: true,
          addedLines: added,
          removedLines: removed,
          originalContent: target.content,
          existed: true,
          action: "update",
        },
        after: applied.content,
      });
      continue;
    }
    const destination = resolveTarget(op.moveTo);
    const destState = await readTarget(destination);
    if (destState.kind !== "missing") {
      plans.push(failed(`cannot move to ${op.moveTo}: it already exists`, added, removed));
      continue;
    }
    plans.push({
      outcome: {
        path: op.moveTo,
        absolute: destination,
        applied: true,
        addedLines: added,
        removedLines: removed,
        // The "before" for the content checks is the file being moved.
        originalContent: target.content,
        existed: false,
        action: "update",
        movedFrom: op.path,
      },
      after: applied.content,
    });
    plans.push({
      outcome: {
        path: op.path,
        absolute,
        applied: true,
        addedLines: 0,
        removedLines: 0,
        originalContent: target.content,
        existed: true,
        action: "delete",
        movedTo: op.moveTo,
      },
      after: null,
    });
  }

  // One file, one operation: a second mention would apply against text
  // the first one already changed.
  const seen = new Map<string, number>();
  for (const plan of plans) {
    const key = plan.outcome.absolute;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const plan of plans) {
    if ((seen.get(plan.outcome.absolute) ?? 0) > 1) {
      plan.outcome.applied = false;
      plan.outcome.reason = "this file appears more than once in the patch; change it in one *** Update File section";
      plan.after = null;
    }
  }
  return plans;
}
