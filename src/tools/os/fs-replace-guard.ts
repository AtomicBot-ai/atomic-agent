import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { RESTORE_MAX_BYTES, type FileRestoreStore } from "./fs-restore-store.js";

/**
 * The guard `os.fs.write` / `edit` / `patch` run before they replace a
 * file the agent did not create this session. It never blocks: the write
 * lands, the previous content is saved through `FileRestoreStore`, and a
 * line is prepended to the tool result. Loud (`⚠`, with the restore call
 * spelled out) when the replacement looks like a loss; a quiet one-liner
 * for any other replacement of a pre-existing user file.
 */

/**
 * Formats whose first line is a header or the document's shape — a
 * changed first line on one of these is announced loudly even when the
 * size held (the 9-row `sales.csv` had new column names, too).
 */
export const HEADER_SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
]);

/**
 * What sat at the path before the write. `content` is null past
 * `RESTORE_MAX_BYTES` — such a file is announced but not read or saved.
 */
export interface PriorFile {
  bytes: number;
  content: Buffer | null;
  lines: number | null;
  firstLine: string | null;
}

export type ReplaceChange = "replace" | "shrink";

export interface ReplaceGuardInput {
  store: FileRestoreStore | undefined;
  sessionId: string;
  absolute: string;
  /** The path as the model should spell it in `os.fs.restore`. */
  display: string;
  tool: string;
  /**
   * `replace`: a whole-file write — every pre-existing user file is
   * noted, loudly on a shrink or a header change. `shrink`: an edit or a
   * patch — noted only when the result shrank the file, always loudly.
   */
  change: ReplaceChange;
  prior: PriorFile;
  after: string;
}

export interface ReplacedFileDetails {
  path: string;
  bytesBefore: number;
  linesBefore: number | null;
  linesAfter: number;
  shrunk: boolean;
  headerChanged: boolean;
  saved: "saved" | "too_large" | "failed";
  copy?: string;
}

export interface ReplaceGuardOutcome {
  note: string | null;
  replaced?: ReplacedFileDetails;
}

export const NO_REPLACE_NOTE: ReplaceGuardOutcome = { note: null };

/** Read what `absolute` holds now: null when nothing (or not a regular file). */
export async function readPriorFile(absolute: string): Promise<PriorFile | null> {
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  if (size > RESTORE_MAX_BYTES) {
    return { bytes: size, content: null, lines: null, firstLine: null };
  }
  try {
    const content = await readFile(absolute);
    const text = content.toString("utf8");
    return {
      bytes: content.byteLength,
      content,
      lines: countLines(text),
      firstLine: firstLine(text),
    };
  } catch {
    return { bytes: size, content: null, lines: null, firstLine: null };
  }
}

/** A `PriorFile` for content a tool already holds as text (edit, patch). */
export function priorFromText(text: string): PriorFile {
  const content = Buffer.from(text, "utf8");
  return {
    bytes: content.byteLength,
    content,
    lines: countLines(text),
    firstLine: firstLine(text),
  };
}

/** Lines as an editor counts them: a trailing newline does not open one more. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let newlines = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    newlines++;
  }
  return text.endsWith("\n") ? newlines : newlines + 1;
}

export function firstLine(text: string): string {
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Did the line count drop by 80 % or more? Integer arithmetic: dropped/before ≥ 4/5. */
export function isShrink(linesBefore: number, linesAfter: number): boolean {
  return linesBefore > 0 && (linesBefore - linesAfter) * 5 >= linesBefore * 4;
}

export async function guardReplacedFile(
  input: ReplaceGuardInput,
): Promise<ReplaceGuardOutcome> {
  const { prior, store } = input;
  // No store (embedders, tests) means nothing could be brought back, so
  // nothing is claimed; an empty file has nothing to lose.
  if (store === undefined || prior.bytes === 0) return NO_REPLACE_NOTE;
  if (await store.wasCreated(input.sessionId, input.absolute)) {
    return NO_REPLACE_NOTE;
  }
  const linesAfter = countLines(input.after);
  const shrunk = prior.lines !== null && isShrink(prior.lines, linesAfter);
  const headerChanged =
    input.change === "replace" &&
    prior.firstLine !== null &&
    HEADER_SENSITIVE_EXTENSIONS.has(extname(input.absolute).toLowerCase()) &&
    prior.firstLine !== firstLine(input.after);
  if (input.change === "shrink" && !shrunk) return NO_REPLACE_NOTE;
  // A file too large to read is a loud case: nothing about it is known
  // except that it was the user's and it is gone.
  const loud = shrunk || headerChanged || prior.lines === null;

  let saved: ReplacedFileDetails["saved"] = "too_large";
  let copyFile: string | undefined;
  let failure = "";
  if (prior.content !== null && prior.bytes <= RESTORE_MAX_BYTES) {
    try {
      const copy = await store.saveCopy(
        input.sessionId,
        input.absolute,
        prior.content,
        { tool: input.tool, lines: prior.lines ?? 0 },
      );
      saved = "saved";
      copyFile = copy.file;
    } catch (err) {
      saved = "failed";
      failure = (err as Error).message;
    }
  }

  const counts = formatCounts(prior, linesAfter, headerChanged);
  const verb = input.change === "replace" ? "replaced" : "shrank";
  const head = `${verb} the user's file \`${input.display}\` (${counts})`;
  const tail =
    saved === "saved"
      ? loud
        ? `the previous content is saved — \`os.fs.restore ${JSON.stringify({ path: input.display })}\` brings it back`
        : "previous content saved"
      : saved === "too_large"
        ? `the previous content was too large to save (over ${formatBytes(RESTORE_MAX_BYTES)})`
        : `the previous content could not be saved: ${failure}`;
  const note = `${loud ? "⚠ " : ""}${head}; ${tail}`;
  return {
    note,
    replaced: {
      path: input.absolute,
      bytesBefore: prior.bytes,
      linesBefore: prior.lines,
      linesAfter,
      shrunk,
      headerChanged,
      saved,
      ...(copyFile !== undefined ? { copy: copyFile } : {}),
    },
  };
}

/** Prepend the guard's line(s) to the summary; a batch of outcomes (patch) keeps file order. */
export function withReplaceNotes(
  result: CompressedToolResult,
  outcomes: readonly ReplaceGuardOutcome[],
): CompressedToolResult {
  const noted = outcomes.filter((o) => o.note !== null);
  if (noted.length === 0) return result;
  const notes = noted.map((o) => o.note).join("\n");
  const replaced = noted.map((o) => o.replaced);
  return {
    ...result,
    summary:
      result.summary.length > 0 ? `${notes}\n${result.summary}` : notes,
    details: {
      ...result.details,
      replaced: replaced.length === 1 ? replaced[0] : replaced,
    },
  };
}

/** `2,401 lines → 10, header changed`, or `12.3 MB → 10 lines` when the file was never read. */
function formatCounts(
  prior: PriorFile,
  linesAfter: number,
  headerChanged: boolean,
): string {
  const counts =
    prior.lines === null
      ? `${formatBytes(prior.bytes)} → ${formatLines(linesAfter)}`
      : `${formatLines(prior.lines)} → ${formatNumber(linesAfter)}`;
  return headerChanged ? `${counts}, header changed` : counts;
}

export function formatLines(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? "line" : "lines"}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
