import { OS_FS_PATCH_CONTRACT } from "./fs-patch-contract.js";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { refuseMaskedSecretWrite } from "./fs-masked-secret-guard.js";
import { dirname, basename } from "node:path";
import { parsePatch } from "diff";
import type { StructuredPatch } from "diff";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import { resolveUserPath } from "../expand-home.js";
import { checkChangedFile } from "./fs-content-check.js";
import { withParseWarning } from "./fs-parse-check.js";
import { dryRunFile, type PreviewOutcome } from "./fs-patch-preview.js";
import {
  CodexPatchParseError,
  looksLikeCodexPatch,
  parseCodexPatch,
  planCodexPatch,
  type CodexFileOp,
} from "./fs-patch-codex.js";
import {
  changedSinceRead,
  recordOwnWrite,
  staleReadNoticeFor,
  withStaleReadNotice,
} from "./fs-read-freshness.js";
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
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";

export type { FileOutcome, PreviewOutcome } from "./fs-patch-preview.js";

interface PatchArgs {
  patch: string;
  apply: boolean;
  rootDir: string;
  fuzzFactor: number;
  stripComponents: number;
  format: PatchFormat;
}

/** `auto` (default) reads a `*** Begin Patch` envelope as codex, anything else as a unified diff. */
type PatchFormat = "auto" | "unified" | "codex";

export function buildOsFsPatchTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: OS_FS_PATCH_CONTRACT.name,
    description: OS_FS_PATCH_CONTRACT.description,
    readonly: OS_FS_PATCH_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = await parseArgs(rawArgs, ctx.workingDir);
      const planned = useCodexFormat(args)
        ? await planCodexPatch(safeParseCodexPatch(args.patch), args.rootDir)
        : await planUnifiedPatch(args);
      const previews = planned.map((p) => p.outcome);

      if (!args.apply) {
        return buildResult(previews, "dry-run");
      }

      // For live apply we need approval before mutating disk. Preview
      // contents are rebuilt the same way as dry-run, so the approval
      // message can faithfully describe what will land.
      const allApplicable = previews.every((p) => p.applied);
      // A `[redacted:…]` marker copied out of masked tool output must not
      // land over the real secret (ATO-1077). Checked on every file
      // before the prompt, so a refused patch writes nothing.
      for (const { outcome, after } of planned) {
        if (!outcome.applied || after === null) continue;
        refuseMaskedSecretWrite("os.fs.patch", outcome.path, outcome.originalContent ?? "", after);
      }
      const preview = formatReport(previews, "applied");
      await requireFsApproval(
        options,
        {
          kind: "write",
          paths: previews.map((p) => p.absolute),
          sessionId: ctx.sessionId,
          tool: "os.fs.patch",
          reason: `apply ${planned.length} patch file(s) under ${args.rootDir}`,
          preview,
          affectedResources: previews.map((p) => p.absolute),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      // Files that changed since the model last read them (ATO-659): a
      // fuzzy hunk can land on text the model never saw, and a refused
      // one most likely failed for exactly this reason. Noted, not refused.
      const changedPaths: string[] = [];
      for (const p of previews) {
        if (await changedSinceRead(ctx.fileVersions, p.absolute)) {
          changedPaths.push(p.absolute);
        }
      }
      const noteChanged = (result: CompressedToolResult): CompressedToolResult =>
        withStaleReadNotice(
          result,
          changedPaths.length > 0,
          staleReadNoticeFor(changedPaths),
        );

      if (!allApplicable) {
        // Refuse to partially apply: either the whole patch lands, or we
        // bail before writing anything. This keeps the agent's mental
        // model simple and avoids half-broken trees.
        return noteChanged(buildResult(previews, "apply-refused"));
      }

      const parseWarnings: string[] = [];
      const guards: ReplaceGuardOutcome[] = [];
      for (const { outcome, after } of planned) {
        if (after === null) {
          // `*** Delete File` (or the old path of a move): the previous
          // content is saved first when a restore store is wired, so
          // `os.fs.restore` can bring it back.
          guards.push(await guardAfterPatch(options, ctx, outcome, ""));
          await unlink(outcome.absolute);
          continue;
        }
        if (!outcome.existed) {
          await mkdir(dirname(outcome.absolute), { recursive: true });
        }
        await writeFile(outcome.absolute, after, "utf8");
        await recordOwnWrite(ctx.fileVersions, outcome.absolute);
        guards.push(await guardAfterPatch(options, ctx, outcome, after));
        const warning = parseWarningAfterPatch(
          outcome,
          after,
          ctx.workingDir,
        );
        if (warning !== null) parseWarnings.push(warning);
      }

      return noteChanged(withReplaceNotes(
        withParseWarning(
          buildResult(previews, "applied"),
          parseWarnings.length > 0 ? parseWarnings.join("\n") : null,
        ),
        guards,
      ));
    },
  };
}

/** One file of the patch: its dry-run outcome and the content it would land (null: removed). */
interface PlannedFile {
  outcome: PreviewOutcome;
  after: string | null;
}

async function planUnifiedPatch(args: PatchArgs): Promise<PlannedFile[]> {
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
  return previews.map((outcome) => ({
    outcome,
    after: outcome.patchedContent ?? "",
  }));
}

function useCodexFormat(args: PatchArgs): boolean {
  if (args.format === "codex") return true;
  if (args.format === "unified") return false;
  return looksLikeCodexPatch(args.patch);
}

/**
 * A patch that created the file marks it as the agent's; one that cut a
 * user's file down by 80 % or more saves what it replaced and says so
 * (`fs-replace-guard.ts`). The absolute path is what the note spells,
 * since a patch path is relative to `rootDir`, not the working dir.
 */
async function guardAfterPatch(
  options: FsDangerousToolOptions,
  ctx: Pick<ToolContext, "sessionId" | "workingDir">,
  outcome: PreviewOutcome,
  patched: string,
): Promise<ReplaceGuardOutcome> {
  if (!outcome.existed) {
    try {
      await options.restore?.recordCreated(ctx.sessionId, outcome.absolute);
    } catch {
      // Best effort: the patch landed either way.
    }
    return { note: null };
  }
  return guardReplacedFile({
    store: options.restore,
    sessionId: ctx.sessionId,
    workingDir: ctx.workingDir,
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

  const format = parseFormat(rawArgs.format);

  return { patch: patchString, apply, rootDir, fuzzFactor, stripComponents, format };
}

function parseFormat(raw: unknown): PatchFormat {
  if (raw === undefined || raw === null) return "auto";
  if (raw === "auto" || raw === "unified" || raw === "codex") return raw;
  throw new Error(
    'os.fs.patch: `format` must be "auto", "unified" or "codex"',
  );
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

function safeParseCodexPatch(source: string): CodexFileOp[] {
  try {
    return parseCodexPatch(source);
  } catch (err) {
    if (err instanceof CodexPatchParseError) {
      throw new Error(
        `os.fs.patch: failed to parse the *** Begin Patch format — ${err.message}`,
      );
    }
    throw err;
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
          ...(p.action !== undefined ? { action: p.action } : {}),
          ...(p.movedFrom !== undefined ? { movedFrom: p.movedFrom } : {}),
          ...(p.movedTo !== undefined ? { movedTo: p.movedTo } : {}),
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
    if (p.action === "add") bits.push("(new file)");
    if (p.movedFrom !== undefined) bits.push(`(moved from ${p.movedFrom})`);
    if (p.action === "delete") {
      bits.push(p.movedTo !== undefined ? `(moved to ${p.movedTo})` : "(deleted)");
    }
    if (p.reason) bits.push(p.reason);
    lines.push(`  ${bits.join("  ")}`);
  }
  return lines.join("\n");
}

// re-export for the rare test that wants to assert path resolution directly.
export const _internal = { dirname, basename };
