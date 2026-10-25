import { OS_FS_EDIT_CONTRACT, parseEditArgs as parseArgs } from "./fs-edit-contract.js";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  compressToolResult,
  retainToolOutput,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import { checkChangedFile } from "./fs-content-check.js";
import {
  clampDiffPreview,
  DIFF_SUMMARY_MAX_CHARS,
  DIFF_SUMMARY_MAX_LINES,
  renderUnifiedDiff,
} from "./fs-edit-diff.js";
import {
  findLooseEditMatch,
  matchLineEndings,
  nearestFragment,
  type LooseEditMatch,
} from "./fs-edit-match.js";
import { withParseWarning } from "./fs-parse-check.js";
import {
  guardReplacedFile,
  priorFromText,
  withReplaceNotes,
} from "./fs-replace-guard.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "./fs-require-approval.js";
import {
  changedSinceRead,
  recordOwnWrite,
  withStaleReadError,
  withStaleReadNotice,
} from "./fs-read-freshness.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";

export function buildOsFsEditTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: OS_FS_EDIT_CONTRACT.name,
    description:
      OS_FS_EDIT_CONTRACT.description,
    readonly: OS_FS_EDIT_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs);
      const absolute = resolveUserPath(args.path, ctx.workingDir);
      // Asked before the file is read for the edit: did it change since
      // the model last read it (ATO-659)? Either way the edit proceeds;
      // the answer only adds a notice to the result or the error.
      const changed = await changedSinceRead(ctx.fileVersions, absolute);
      try {
        return withStaleReadNotice(
          await editFile(options, args, absolute, ctx),
          changed,
        );
      } catch (err) {
        throw withStaleReadError(err, changed, "os.fs.edit");
      }
    },
  };
}

async function editFile(
  options: FsDangerousToolOptions,
  args: ReturnType<typeof parseArgs>,
  absolute: string,
  ctx: ToolContext,
): Promise<CompressedToolResult> {
  const info = await stat(absolute);
  if (!info.isFile()) {
    throw new Error(`os.fs.edit: ${absolute} is not a regular file`);
  }
  const original = await readFile(absolute, "utf8");
  const exact = countOccurrences(original, args.oldString);
  // No exact hit: a unique whole-line match that differs only by
  // blank lines or trailing whitespace is applied and said so;
  // anything else is refused with the nearest fragment to copy
  // (ATO-785, `fs-edit-match.ts`). Never an ambiguous match.
  const loose: LooseEditMatch | null =
    exact === 0 ? resolveLooseMatch(original, args.oldString) : null;
  const occurrences = exact === 0 ? 1 : exact;
  if (occurrences > 1 && !args.replaceAll) {
    throw new Error(
      `os.fs.edit: \`oldString\` is not unique (found ${occurrences} occurrences). Provide more surrounding context to make it unique, or set \`replaceAll=true\`.`,
    );
  }

  const updated =
    loose !== null
      ? original.slice(0, loose.start) +
        matchLineEndings(
          args.newString,
          original.slice(loose.start, loose.end),
        ) +
        original.slice(loose.end)
      : args.replaceAll
        ? replaceAll(original, args.oldString, args.newString)
        : replaceOnce(original, args.oldString, args.newString);
  const diff = renderUnifiedDiff(original, updated, absolute);
  const preview = clampDiffPreview(diff);
  await requireFsApproval(
    options,
    {
      kind: "write",
      paths: [absolute],
      sessionId: ctx.sessionId,
      tool: "os.fs.edit",
      reason: `edit ${occurrences} occurrence${occurrences > 1 ? "s" : ""} in ${absolute}`,
      preview,
      affectedResources: [absolute],
      workingDir: ctx.workingDir,
      trustConfigPaths: options.trustConfigPaths,
    },
    ctx.signal,
  );

  await atomicWrite(absolute, updated);
  await recordOwnWrite(ctx.fileVersions, absolute);

  // An edit that cut a user's file down by 80 % or more — the blind
  // `replaceAll` that ate a dataset — saves what it replaced and says
  // so (`fs-replace-guard.ts`); an ordinary edit is silent here.
  const guard = await guardReplacedFile({
    store: options.restore,
    sessionId: ctx.sessionId,
    workingDir: ctx.workingDir,
    absolute,
    display: args.path,
    tool: "os.fs.edit",
    change: "shrink",
    prior: priorFromText(original),
    after: updated,
  });

  const replacedOccurrences =
    args.replaceAll && loose === null ? occurrences : 1;
  // Judged after the write landed, against the file as it was before:
  // an edit that turns a parsing file into a broken one — the classic
  // blind `replaceAll` — is told so, with the count, so the model
  // undoes it instead of stacking another edit on top.
  const parseWarning = checkChangedFile({
    absolute,
    workingDir: ctx.workingDir,
    change: "edit",
    before: original,
    after: updated,
    replacedOccurrences,
  });

  return withReplaceNotes(
    withParseWarning(
      withLooseMatchNote(
        // The diff is already clipped, by `renderUnifiedDiff`, to a
        // length chosen for diffs. Left to its defaults the compressor
        // would undo that considered cap with one that knows nothing
        // about them — 12 tail lines and 385 chars — so we pass the
        // renderer's own bounds instead (see `fs-edit-diff.ts`).
        compressToolResult(
          {
            tool: "os.fs.edit",
            status: "ok",
            output:
              diff.length > 0 ? diff : `(no textual diff — file rewritten)`,
            details: {
              path: absolute,
              replacedOccurrences,
              replaceAll: args.replaceAll,
              sizeBefore: Buffer.byteLength(original, "utf8"),
              sizeAfter: Buffer.byteLength(updated, "utf8"),
            },
          },
          {
            maxSummaryLength: DIFF_SUMMARY_MAX_CHARS,
            maxTailLines: DIFF_SUMMARY_MAX_LINES,
          },
        ),
        loose !== null,
      ),
      parseWarning,
    ),
    [guard],
  );
}

/** First line of a result whose edit landed on a whitespace-tolerant match. */
export const LOOSE_MATCH_NOTE =
  "note: oldString was not found exactly; it matched one place once blank lines and trailing spaces were ignored, and the edit was applied there. Check the diff.";

/**
 * Prefix the note after compression, the way a parse warning is, so a
 * long diff's tail clipping can never drop it.
 */
function withLooseMatchNote(
  result: CompressedToolResult,
  loose: boolean,
): CompressedToolResult {
  if (!loose) return result;
  return retainToolOutput(
    result,
    {
      ...result,
      summary: `${LOOSE_MATCH_NOTE}\n${result.summary}`,
      details: { ...result.details, matchedBy: "whitespace" },
    },
    { prefix: `${LOOSE_MATCH_NOTE}\n` },
  );
}

/**
 * The whitespace-tolerant match, or an error that tells the model what
 * to send instead of the same edit again.
 */
function resolveLooseMatch(original: string, oldString: string): LooseEditMatch {
  const lookup = findLooseEditMatch(original, oldString);
  if (lookup.kind === "unique") return lookup.match;
  if (lookup.kind === "ambiguous") {
    throw new Error(
      `os.fs.edit: \`oldString\` was not found exactly, and ignoring blank lines and trailing spaces it matches ${lookup.count} places, so nothing was changed. Include more surrounding lines, copied exactly from the file.`,
    );
  }
  const fragment = nearestFragment(original, oldString);
  // The quote of the file goes on its own line: the first line of an
  // error is what the `tool executed` log keeps, and file text stays
  // out of the log.
  throw new Error(
    fragment === null
      ? "os.fs.edit: `oldString` was not found in the target file. Provide the exact substring (including whitespace/indent). For a rename, a one-line oldString with replaceAll: true is safer."
      : `os.fs.edit: \`oldString\` was not found in the target file.\nNearest text in the file, as JSON: ${fragment}. Copy it exactly (blank lines and indentation included), or use a shorter one-line oldString.`,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function replaceOnce(
  source: string,
  oldString: string,
  newString: string,
): string {
  const idx = source.indexOf(oldString);
  if (idx === -1) return source;
  return (
    source.slice(0, idx) + newString + source.slice(idx + oldString.length)
  );
}

function replaceAll(
  source: string,
  oldString: string,
  newString: string,
): string {
  // Avoid String.prototype.replaceAll here so we don't need to escape regex
  // metachars inside `oldString` when falling back to String.replace.
  const parts: string[] = [];
  let cursor = 0;
  while (true) {
    const idx = source.indexOf(oldString, cursor);
    if (idx === -1) {
      parts.push(source.slice(cursor));
      break;
    }
    parts.push(source.slice(cursor, idx));
    parts.push(newString);
    cursor = idx + oldString.length;
  }
  return parts.join("");
}

/**
 * Write `content` atomically: create a sibling temp file, flush, then
 * `rename` over the target. If the rename fails, the temp file is removed
 * so the original file is never clobbered.
 */
async function atomicWrite(target: string, content: string): Promise<void> {
  const dir = dirname(target);
  const suffix = randomBytes(6).toString("hex");
  const temp = resolve(dir, `.${suffix}.atomic-agent.tmp`);
  try {
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  } catch (err) {
    try {
      await unlink(temp);
    } catch {
      // best-effort cleanup; rename() may or may not have moved the file.
    }
    throw err;
  }
}
