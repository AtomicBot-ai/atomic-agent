import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import { formatBytes, formatLines } from "./fs-replace-guard.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "./fs-require-approval.js";
import type { ToolDefinition } from "../tool-registry.js";

const PREVIEW_MAX_LEN = 400;

/**
 * `os.fs.restore { path }` — put back the previous content that
 * `os.fs.write` / `edit` / `patch` saved before replacing a user file this
 * session (see `fs-replace-guard.ts`). A write in every sense, so it
 * rides the same approval ladder; the copy stays in the store, so a
 * second restore of the same path still works.
 */
export function buildOsFsRestoreTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.restore",
    description:
      "Bring back the previous content of a file this session replaced or shrank (saved automatically by os.fs.write / os.fs.edit / os.fs.patch). Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("os.fs.restore: `path` must be a non-empty string");
      }
      const store = options.restore;
      if (store === undefined) {
        throw new Error(
          "os.fs.restore: this runtime keeps no restore copies (no state directory)",
        );
      }
      const absolute = resolveUserPath(path, ctx.workingDir);
      const copy = await store.latestCopy(ctx.sessionId, absolute);
      if (copy === null) {
        throw new Error(
          `os.fs.restore: nothing saved for \`${path}\` in this session — only a pre-existing file replaced by os.fs.write / edit / patch has a copy`,
        );
      }
      let content: Buffer;
      try {
        content = await store.readCopy(ctx.sessionId, copy);
      } catch {
        throw new Error(
          `os.fs.restore: the saved copy of \`${path}\` is gone (${copy.file})`,
        );
      }

      const text = content.toString("utf8");
      const preview =
        text.length > PREVIEW_MAX_LEN
          ? `${text.slice(0, PREVIEW_MAX_LEN)}…`
          : text;
      await requireFsApproval(
        options,
        {
          kind: "write",
          paths: [absolute],
          sessionId: ctx.sessionId,
          tool: "os.fs.restore",
          reason: `restore ${absolute} to the ${formatBytes(copy.bytes)} (${formatLines(copy.lines)}) it held before ${copy.tool}`,
          preview,
          affectedResources: [absolute],
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      return compressToolResult({
        tool: "os.fs.restore",
        status: "ok",
        output: `restored \`${path}\` from the copy saved before ${copy.tool}: ${formatBytes(copy.bytes)}, ${formatLines(copy.lines)}`,
        details: {
          path: absolute,
          bytes: copy.bytes,
          lines: copy.lines,
          savedAt: copy.savedAt,
          savedBefore: copy.tool,
          copy: copy.file,
        },
      });
    },
  };
}
