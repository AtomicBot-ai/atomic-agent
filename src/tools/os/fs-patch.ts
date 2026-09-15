import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { applyPatch, parsePatch } from "diff";
import type { StructuredPatch } from "diff";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import { checkChangedFile } from "./fs-content-check.js";
import { withParseWarning } from "./fs-parse-check.js";
import { dryRunFile, type PreviewOutcome } from "./fs-patch-preview.js";
import {
  guardReplacedFile,
  priorFromText,
  withReplaceNotes,
  type ReplaceGuardOutcome,
} from "./fs-replace-guard.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "./fs-require-approval.js";
import type { ToolDefinition } from "../tool-registry.js";

export type { FileOutcome, PreviewOutcome } from "./fs-patch-preview.js";

interface PatchArgs {
  patch: string;
  apply: boolean;
  rootDir: string;
  fuzzFactor: number;
  stripComponents: number;
}

export function buildOsFsPatchTool(
  options: FsDangerousToolOptions,
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
          dryRunFile(
            hunkFile,
            args.rootDir,
            args.fuzzFactor,
            args.stripComponents,
          ),
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
      await requireFsApproval(
        options,
        {
          kind: "write",
          paths: previews.map((p) => p.absolute),
          sessionId: ctx.sessionId,
          tool: "os.fs.patch",
          reason: `apply ${parsed.length} patch file(s) under ${args.rootDir}`,
          preview,
          affectedResources: previews.map((p) => p.absolute),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      if (!allApplicable) {
        // Refuse to partially apply: either the whole patch lands, or we
        // bail before writing anything. This keeps the agent's mental
        // model simple and avoids half-broken trees.
        return buildResult(previews, "apply-refused");
      }

      const parseWarnings: string[] = [];
      const guards: ReplaceGuardOutcome[] = [];
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
        guards.push(
          await guardAfterPatch(options, ctx.sessionId, outcome, patched),
        );
        const warning = parseWarningAfterPatch(
          outcome,
          patched,
          ctx.workingDir,
        );
        if (warning !== null) parseWarnings.push(warning);
      }

      return withReplaceNotes(
        withParseWarning(
          buildResult(previews, "applied"),
          parseWarnings.length > 0 ? parseWarnings.join("\n") : null,
        ),
        guards,
      );
    },
  };
}

/**
 * A patch that created the file marks it as the agent's; one that cut a
 * user's file down by 80 % or more saves what it replaced and says so
 * (`fs-replace-guard.ts`). The absolute path is what the note spells,
 * since a patch path is relative to `rootDir`, not the working dir.
 */
async function guardAfterPatch(
  options: FsDangerousToolOptions,
  sessionId: string,
  outcome: PreviewOutcome,
  patched: string,
): Promise<ReplaceGuardOutcome> {
  if (!outcome.existed) {
    try {
      await options.restore?.recordCreated(sessionId, outcome.absolute);
    } catch {
      // Best effort: the patch landed either way.
    }
    return { note: null };
  }
  return guardReplacedFile({
    store: options.restore,
    sessionId,
    absolute: outcome.absolute,
    display: outcome.absolute,
    tool: "os.fs.patch",
    change: "shrink",
    prior: priorFromText(outcome.originalContent ?? ""),
    after: patched,
  });
}

/**
 * The warnings for one applied file (see `fs-parse-check.ts` and
 * `fs-content-check.ts`), or null. A file the patch emptied is a
 * unified-diff deletion, not a broken file, and a file the patch created
 * has no "before" to compare.
 */
function parseWarningAfterPatch(
  outcome: PreviewOutcome,
  patched: string,
  workingDir: string,
): string | null {
  if (patched.length === 0) return null;
  const original = outcome.originalContent ?? "";
  return checkChangedFile({
    absolute: outcome.absolute,
    workingDir,
    change: "patch",
    after: patched,
    ...(original.length > 0 ? { before: original } : {}),
  });
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
    const abs = resolveUserPath(patchPath, workingDir);
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
      ? resolveUserPath(rootDirRaw, workingDir)
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
    throw new Error(`os.fs.patch: \`${field}\` must be a non-negative number`);
  }
  return Math.floor(raw);
}

function safeParsePatch(source: string): StructuredPatch[] {
  try {
    return parsePatch(source) as StructuredPatch[];
  } catch (err) {
    throw new Error(
      `os.fs.patch: failed to parse patch — ${(err as Error).message}`,
    );
  }
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
