import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { ToolDefinition } from "../tool-registry.js";

const DIFF_MAX_LINES = 40;
const PREVIEW_MAX_LEN = 800;

interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export function buildOsFsEditTool(
  options: DangerousToolOptions,
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
      const preview = clamp(diff, PREVIEW_MAX_LEN);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.fs.edit",
          reason: `edit ${occurrences} occurrence${occurrences > 1 ? "s" : ""} in ${absolute}`,
          preview,
          affectedResources: [absolute],
        },
        ctx.signal,
      );

      await atomicWrite(absolute, updated);

      return compressToolResult({
        tool: "os.fs.edit",
        status: "ok",
        output: diff.length > 0 ? diff : `(no textual diff — file rewritten)`,
        details: {
          path: absolute,
          replacedOccurrences: args.replaceAll ? occurrences : 1,
          replaceAll: args.replaceAll,
          sizeBefore: Buffer.byteLength(original, "utf8"),
          sizeAfter: Buffer.byteLength(updated, "utf8"),
        },
      });
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

function replaceOnce(source: string, oldString: string, newString: string): string {
  const idx = source.indexOf(oldString);
  if (idx === -1) return source;
  return source.slice(0, idx) + newString + source.slice(idx + oldString.length);
}

function replaceAll(source: string, oldString: string, newString: string): string {
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

/**
 * Minimal unified diff, capped at DIFF_MAX_LINES total lines. We avoid a
 * full LCS algorithm: the edit is a single substring replacement, so the
 * diff is well approximated by a simple before/after line listing around
 * the changed region.
 */
function renderUnifiedDiff(before: string, after: string, path: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const firstDiff = findFirstDiffLine(beforeLines, afterLines);
  if (firstDiff === -1) return "";
  const contextBefore = 2;
  const contextAfter = 2;
  const head = Math.max(0, firstDiff - contextBefore);
  const lastDiffBefore = findLastDiffLine(beforeLines, afterLines);
  const lastDiffAfter = findLastDiffLineFromEnd(beforeLines, afterLines);
  const tailBefore = Math.min(beforeLines.length - 1, lastDiffBefore + contextAfter);

  const segments: string[] = [];
  segments.push(`--- a/${path}`);
  segments.push(`+++ b/${path}`);
  for (let i = head; i <= Math.min(beforeLines.length - 1, tailBefore) && i < firstDiff; i++) {
    segments.push(` ${beforeLines[i]}`);
  }
  for (let i = firstDiff; i <= lastDiffBefore; i++) {
    segments.push(`-${beforeLines[i] ?? ""}`);
  }
  for (let i = firstDiff; i <= lastDiffAfter; i++) {
    segments.push(`+${afterLines[i] ?? ""}`);
  }
  for (
    let i = Math.max(lastDiffBefore + 1, firstDiff);
    i <= tailBefore && i < beforeLines.length;
    i++
  ) {
    segments.push(` ${beforeLines[i]}`);
  }
  if (segments.length > DIFF_MAX_LINES + 2) {
    return segments.slice(0, DIFF_MAX_LINES + 2).join("\n") + "\n… [diff truncated]";
  }
  return segments.join("\n");
}

function findFirstDiffLine(before: string[], after: string[]): number {
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i] !== after[i]) return i;
  }
  if (before.length !== after.length) return limit;
  return -1;
}

function findLastDiffLine(before: string[], after: string[]): number {
  // Returns the last index in `before` that differs from `after` (walking
  // from the end). Treats missing indices as different.
  const len = Math.max(before.length, after.length);
  for (let i = before.length - 1, j = after.length - 1; i >= 0 && j >= 0; i--, j--) {
    if (before[i] !== after[j]) return i;
  }
  if (before.length < after.length) return -1;
  return before.length - 1 - (len - Math.max(before.length, after.length));
}

function findLastDiffLineFromEnd(before: string[], after: string[]): number {
  for (let i = after.length - 1, j = before.length - 1; i >= 0 && j >= 0; i--, j--) {
    if (after[i] !== before[j]) return i;
  }
  if (after.length > before.length) return after.length - 1;
  return -1;
}

function clamp(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 15) + "\n… [truncated]";
}
