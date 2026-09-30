import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import { checkChangedFile } from "./fs-content-check.js";
import {
  clampDiffPreview,
  DIFF_SUMMARY_MAX_CHARS,
  DIFF_SUMMARY_MAX_LINES,
  renderUnifiedDiff,
} from "./fs-edit-diff.js";
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
import type { ToolDefinition } from "../tool-registry.js";

interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export function buildOsFsEditTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.edit",
    description:
      "Surgically replace an exact substring in a UTF-8 text file. Requires `oldString` to be unique unless `replaceAll=true`. Atomic (temp-file + rename). Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs);
      const absolute = resolveUserPath(args.path, ctx.workingDir);
      const info = await stat(absolute);
      if (!info.isFile()) {
        throw new Error(`os.fs.edit: ${absolute} is not a regular file`);
      }
      const original = await readFile(absolute, "utf8");
      const occurrences = countOccurrences(original, args.oldString);
      if (occurrences === 0) {
        throw new Error(
          "os.fs.edit: `oldString` was not found in the target file. Provide the exact substring (including whitespace/indent).",
        );
      }
      if (occurrences > 1 && !args.replaceAll) {
        throw new Error(
          `os.fs.edit: \`oldString\` is not unique (found ${occurrences} occurrences). Provide more surrounding context to make it unique, or set \`replaceAll=true\`.`,
        );
      }

      const updated = args.replaceAll
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

      const replacedOccurrences = args.replaceAll ? occurrences : 1;
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
          parseWarning,
        ),
        [guard],
      );
    },
  };
}

function parseArgs(rawArgs: Record<string, unknown>): EditArgs {
  const path = rawArgs.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("os.fs.edit: `path` must be a non-empty string");
  }
  const oldString = rawArgs.oldString;
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("os.fs.edit: `oldString` must be a non-empty string");
  }
  const newString = rawArgs.newString;
  if (typeof newString !== "string") {
    throw new Error("os.fs.edit: `newString` must be a string");
  }
  if (oldString === newString) {
    throw new Error("os.fs.edit: `newString` must differ from `oldString`");
  }
  const replaceAll = rawArgs.replaceAll === true;
  return { path, oldString, newString, replaceAll };
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
