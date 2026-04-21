import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, dirname, basename } from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { StructuredPatch } from "diff";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

/**
 * Per-file outcome of applying a patch. Tracked per target so the tool can
 * report "files 1/3 applied, 2/3 rejected" instead of silently dropping
 * bad hunks.
 */
interface FileOutcome {
  path: string;
  absolute: string;
  applied: boolean;
  reason?: string;
  addedLines: number;
  removedLines: number;
}

interface PatchArgs {
  patch: string;
  apply: boolean;
  rootDir: string;
  fuzzFactor: number;
  stripComponents: number;
}

export function buildOsFsPatchTool(
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.patch",
    description:
      "Apply a unified diff to files on disk. `apply=false` (default) does a DRY-RUN: it parses the patch, attempts to apply each hunk, and returns a preview report without touching the filesystem. `apply=true` writes the result — requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const args = await parseArgs(rawArgs, ctx.workingDir);
      const parsed = safeParsePatch(args.patch);

      const previews = await Promise.all(
        parsed.map((hunkFile) =>
          dryRunFile(hunkFile, args.rootDir, args.fuzzFactor, args.stripComponents),
        ),
      );

      if (!args.apply) {
        return buildResult(previews, "dry-run");
      }

      // For live apply we need approval before mutating disk. Preview
      // contents are rebuilt the same way as dry-run, so the approval
      // message can faithfully describe what will land.
      const allApplicable = previews.every((p) => p.applied);
      const preview = formatReport(previews, "applied");
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.fs.patch",
          reason: `apply ${parsed.length} patch file(s) under ${args.rootDir}`,
          preview,
          affectedResources: previews.map((p) => p.absolute),
        },
        ctx.signal,
      );

      if (!allApplicable) {
        // Refuse to partially apply: either the whole patch lands, or we
        // bail before writing anything. This keeps the agent's mental
        // model simple and avoids half-broken trees.
        return buildResult(previews, "apply-refused");
      }

      for (let i = 0; i < parsed.length; i++) {
        const hunkFile = parsed[i];
        const outcome = previews[i];
        if (!hunkFile || !outcome) continue;
        const patched = applyPatch(
          outcome.originalContent ?? "",
          hunkFile as StructuredPatch,
          { fuzzFactor: args.fuzzFactor },
        );
        if (patched === false) {
          throw new Error(
            `os.fs.patch: hunk re-application failed unexpectedly for ${outcome.path}`,
          );
        }
        await writeFile(outcome.absolute, patched, "utf8");
      }

      return buildResult(previews, "applied");
    },
  };
}

async function parseArgs(
  rawArgs: Record<string, unknown>,
  workingDir: string,
): Promise<PatchArgs> {
  const patch = rawArgs.patch;
  const patchPath = rawArgs.patchPath;
  let patchString: string;
  if (typeof patch === "string" && patch.length > 0) {
    patchString = patch;
  } else if (typeof patchPath === "string" && patchPath.length > 0) {
    const abs = isAbsolute(patchPath)
      ? patchPath
      : resolve(workingDir, patchPath);
    patchString = await readFile(abs, "utf8");
  } else {
    throw new Error(
      "os.fs.patch: provide either `patch` (string) or `patchPath` (file)",
    );
  }

  const apply = rawArgs.apply === true;
  const rootDirRaw = rawArgs.rootDir;
  const rootDir =
    typeof rootDirRaw === "string" && rootDirRaw.length > 0
      ? isAbsolute(rootDirRaw)
        ? rootDirRaw
        : resolve(workingDir, rootDirRaw)
      : workingDir;

  const fuzzFactor = parseNonNegativeInt(rawArgs.fuzzFactor, 0, "fuzzFactor");
  const stripComponents = parseNonNegativeInt(
    rawArgs.stripComponents,
    1,
    "stripComponents",
  );

  return { patch: patchString, apply, rootDir, fuzzFactor, stripComponents };
}

function parseNonNegativeInt(
  raw: unknown,
  fallback: number,
  field: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(
      `os.fs.patch: \`${field}\` must be a non-negative number`,
    );
  }
  return Math.floor(raw);
}

function safeParsePatch(source: string): StructuredPatch[] {
  try {
    return parsePatch(source) as StructuredPatch[];
  } catch (err) {
    throw new Error(`os.fs.patch: failed to parse patch — ${(err as Error).message}`);
  }
}

interface PreviewOutcome extends FileOutcome {
  /** Raw source content at the time of preview (used again when we decide to write). */
  originalContent?: string;
}

async function dryRunFile(
  hunkFile: StructuredPatch,
  rootDir: string,
  fuzzFactor: number,
  stripComponents: number,
): Promise<PreviewOutcome> {
  const targetRel = pickTargetPath(hunkFile, stripComponents);
  const abs = isAbsolute(targetRel)
    ? targetRel
    : resolve(rootDir, targetRel);
  const counts = countLines(hunkFile);

  let originalContent = "";
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return {
        path: targetRel,
        absolute: abs,
        applied: false,
        reason: "target is not a regular file",
        addedLines: counts.added,
        removedLines: counts.removed,
      };
    }
    originalContent = await readFile(abs, "utf8");
  } catch (err) {
    const isMissing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissing) {
      return {
        path: targetRel,
        absolute: abs,
        applied: false,
        reason: `cannot read target: ${(err as Error).message}`,
        addedLines: counts.added,
        removedLines: counts.removed,
      };
    }
    // Missing target is fine only if the patch creates the file from
    // scratch (empty original). Let applyPatch decide.
  }

  const patched = applyPatch(originalContent, hunkFile, { fuzzFactor });
  if (patched === false) {
    return {
      path: targetRel,
      absolute: abs,
      applied: false,
      reason: `hunk(s) did not match (fuzzFactor=${fuzzFactor})`,
      addedLines: counts.added,
      removedLines: counts.removed,
      originalContent,
    };
  }
  return {
    path: targetRel,
    absolute: abs,
    applied: true,
    addedLines: counts.added,
    removedLines: counts.removed,
    originalContent,
  };
}

function pickTargetPath(
  hunkFile: StructuredPatch,
  stripComponents: number,
): string {
  // Prefer the "new" side; fall back to the "old" side for pure deletions.
  const raw =
    typeof hunkFile.newFileName === "string" && hunkFile.newFileName !== "/dev/null"
      ? hunkFile.newFileName
      : hunkFile.oldFileName ?? "";
  return stripPathComponents(raw, stripComponents);
}

function stripPathComponents(p: string, n: number): string {
  if (n <= 0) return p;
  // Drop `a/`, `b/` prefixes that `git diff` emits.
  const parts = p.split(/[\\/]/);
  return parts.slice(Math.min(n, parts.length - 1)).join("/");
}

function countLines(hunkFile: StructuredPatch): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunkFile.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

function buildResult(
  previews: PreviewOutcome[],
  mode: "dry-run" | "applied" | "apply-refused",
): ReturnType<typeof compressToolResult> {
  const output = formatReport(previews, mode);
  const anyFailed = previews.some((p) => !p.applied);
  return compressToolResult(
    {
      tool: "os.fs.patch",
      status: mode === "apply-refused" ? "error" : "ok",
      output,
      details: {
        mode,
        files: previews.map((p) => ({
          path: p.path,
          absolute: p.absolute,
          applied: p.applied,
          reason: p.reason,
          addedLines: p.addedLines,
          removedLines: p.removedLines,
        })),
        anyFailed,
      },
    },
    { maxSummaryLength: 32 * 1024, maxTailLines: 1000 },
  );
}

function formatReport(
  previews: readonly PreviewOutcome[],
  mode: "dry-run" | "applied" | "apply-refused",
): string {
  const header =
    mode === "dry-run"
      ? "patch dry-run:"
      : mode === "applied"
        ? "patch applied:"
        : "patch apply REFUSED — some hunks could not land:";
  const lines = [header];
  for (const p of previews) {
    const mark = p.applied ? "✓" : "✗";
    const bits = [`${mark} ${p.path}`, `+${p.addedLines}/-${p.removedLines}`];
    if (p.reason) bits.push(p.reason);
    lines.push(`  ${bits.join("  ")}`);
  }
  return lines.join("\n");
}

// re-export for the rare test that wants to assert path resolution directly.
export const _internal = { dirname, basename };
