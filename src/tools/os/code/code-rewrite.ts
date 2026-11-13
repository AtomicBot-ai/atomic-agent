import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createPatch } from "diff";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { checkChangedFile } from "../fs/fs-content-check.js";
import { refuseMaskedSecretWrite } from "../fs/fs-masked-secret-guard.js";
import { withParseWarning } from "../fs/fs-parse-check.js";
import {
  changedSinceRead,
  recordOwnWrite,
  staleReadNoticeFor,
  withStaleReadNotice,
} from "../fs/fs-read-freshness.js";
import {
  guardReplacedFile,
  priorFromText,
  withReplaceNotes,
  type ReplaceGuardOutcome,
} from "../fs/fs-replace-guard.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "../fs/fs-require-approval.js";
import type { AstGrepMatch } from "./ast-grep-json.js";
import { AST_GREP_MISSING_HINT } from "./ast-grep-resolver.js";
import {
  astGrepDependencies,
  parseAstGrepQuery,
  runAstGrep,
  type AstGrepDependencies,
} from "./ast-grep-run.js";
import { OS_CODE_REWRITE_CONTRACT } from "./code-rewrite-contract.js";
import { displayPath } from "./code-search.js";

const TOOL = OS_CODE_REWRITE_CONTRACT.name;
/** ast-grep's JSON for a rewrite must arrive whole: a cut list would change some files and not others. */
const REWRITE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Files one rewrite may change. */
export const CODE_REWRITE_MAX_FILES = 200;
/** The diff in the result and the approval card is clipped to this. */
const PREVIEW_MAX_CHARS = 24 * 1024;

/** One file the rewrite changes, or the reason it cannot. */
export interface RewriteFilePlan {
  absolute: string;
  display: string;
  matches: number;
  before: string;
  after: string | null;
  reason?: string;
}

export function buildOsCodeRewriteTool(
  options: FsDangerousToolOptions,
  deps: Partial<AstGrepDependencies> = {},
): ToolDefinition {
  const resolved = astGrepDependencies(deps);
  return {
    name: TOOL,
    description: OS_CODE_REWRITE_CONTRACT.description,
    readonly: OS_CODE_REWRITE_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const query = parseAstGrepQuery(rawArgs, TOOL, true);
      const apply = rawArgs.apply === true;
      const binary = resolved.resolveAstGrepPath();
      if (binary === null) {
        return errorResult(AST_GREP_MISSING_HINT, { missing: true, hint: AST_GREP_MISSING_HINT });
      }
      const outcome = await runAstGrep(query, binary, resolved, ctx, REWRITE_MAX_OUTPUT_BYTES);
      if (outcome.kind === "error") return errorResult(outcome.message, outcome.details);
      const { matches, result, command } = outcome;
      if (result.timedOut || result.truncated) {
        return errorResult(
          result.timedOut
            ? `ast-grep stopped after ${query.timeoutMs} ms before listing every match; nothing was changed. Narrow \`path\` or \`globs\`, or raise timeoutMs.`
            : "ast-grep printed more than this tool can take in one rewrite; nothing was changed. Narrow `path` or `globs`.",
          { command, timedOut: result.timedOut, truncated: result.truncated },
        );
      }
      if (matches.length === 0) {
        return compressToolResult({
          tool: TOOL,
          status: "ok",
          output: "(no matches; nothing to rewrite)",
          details: { mode: apply ? "applied" : "dry-run", files: [], totals: { files: 0, matches: 0 }, command },
        });
      }

      const plans = await planRewrite(matches, ctx.workingDir);
      if (plans.length > CODE_REWRITE_MAX_FILES) {
        return errorResult(
          `the rewrite would change ${plans.length} files (at most ${CODE_REWRITE_MAX_FILES} at once); nothing was changed. Narrow \`path\` or \`globs\` and run it in parts.`,
          { command, files: plans.length },
        );
      }
      const changed = plans.filter((p) => p.after !== null && p.after !== p.before);
      const diff = renderDiff(changed);
      const allApplicable = plans.every((p) => p.reason === undefined);

      if (!apply) return buildResult(plans, "dry-run", diff, command);

      // A `[redacted:…]` marker in `rewrite` must not land over a real
      // secret (ATO-1077); checked before the prompt.
      for (const p of changed) refuseMaskedSecretWrite(TOOL, p.display, p.before, p.after!);
      if (!allApplicable) return buildResult(plans, "apply-refused", diff, command);
      if (changed.length === 0) return buildResult(plans, "applied", diff, command);

      await requireFsApproval(
        options,
        {
          kind: "write",
          paths: changed.map((p) => p.absolute),
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `rewrite ${countMatches(changed)} match(es) of \`${clipInline(query.pattern)}\` in ${changed.length} file(s)`,
          preview: diff,
          affectedResources: changed.map((p) => p.absolute),
          workingDir: ctx.workingDir,
          trustConfigPaths: options.trustConfigPaths,
        },
        ctx.signal,
      );

      // A file edited between the search and the approval is not
      // overwritten with offsets computed on its older text.
      for (const p of changed) {
        const now = await readFile(p.absolute, "utf8").catch(() => null);
        if (now !== p.before) {
          return errorResult(
            `${p.display} changed while the rewrite waited for approval; nothing was written. Run the rewrite again.`,
            { command, changedDuringApproval: p.display },
          );
        }
      }
      const changedPaths: string[] = [];
      for (const p of changed) {
        if (await changedSinceRead(ctx.fileVersions, p.absolute)) changedPaths.push(p.display);
      }

      const guards: ReplaceGuardOutcome[] = [];
      const warnings: string[] = [];
      for (const p of changed) {
        const after = p.after!;
        await writeFile(p.absolute, after, "utf8");
        await recordOwnWrite(ctx.fileVersions, p.absolute);
        guards.push(
          await guardReplacedFile({
            store: options.restore,
            sessionId: ctx.sessionId,
            workingDir: ctx.workingDir,
            absolute: p.absolute,
            display: p.display,
            tool: TOOL,
            change: "shrink",
            prior: priorFromText(p.before),
            after,
          }),
        );
        if (after.length > 0) {
          const warning = checkChangedFile({
            absolute: p.absolute,
            workingDir: ctx.workingDir,
            change: "patch",
            after,
            ...(p.before.length > 0 ? { before: p.before } : {}),
          });
          if (warning !== null) warnings.push(warning);
        }
      }
      const done: CompressedToolResult = withReplaceNotes(
        withParseWarning(
          buildResult(plans, "applied", diff, command),
          warnings.length > 0 ? warnings.join("\n") : null,
        ),
        guards,
      );
      return withStaleReadNotice(done, changedPaths.length > 0, staleReadNoticeFor(changedPaths));
    },
  };
}

/**
 * Turn ast-grep's matches into new file contents. Offsets are UTF-8
 * bytes, so the edit is done on the bytes. A file whose text no longer
 * holds a match at its offsets (changed since ast-grep read it), or
 * whose replacements overlap, is refused with a reason.
 */
export async function planRewrite(
  matches: readonly AstGrepMatch[],
  workingDir: string,
): Promise<RewriteFilePlan[]> {
  const byFile = new Map<string, AstGrepMatch[]>();
  for (const m of matches) {
    const absolute = isAbsolute(m.file) ? m.file : resolve(workingDir, m.file);
    const list = byFile.get(absolute) ?? [];
    list.push(m);
    byFile.set(absolute, list);
  }
  const plans: RewriteFilePlan[] = [];
  for (const [absolute, fileMatches] of byFile) {
    const display = displayPath(absolute, workingDir);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (err) {
      plans.push({
        absolute,
        display,
        matches: fileMatches.length,
        before: "",
        after: null,
        reason: `cannot read the file: ${(err as Error).message}`,
      });
      continue;
    }
    const before = bytes.toString("utf8");
    const fail = (reason: string): RewriteFilePlan => ({
      absolute,
      display,
      matches: fileMatches.length,
      before,
      after: null,
      reason,
    });
    const edits = [...fileMatches].sort(
      (a, b) => (a.replaceStart ?? a.byteStart) - (b.replaceStart ?? b.byteStart),
    );
    let problem: string | null = null;
    let lastEnd = -1;
    for (const m of edits) {
      if (m.replacement === undefined) {
        problem = "ast-grep returned a match without a replacement";
        break;
      }
      if (m.byteEnd > bytes.length || bytes.subarray(m.byteStart, m.byteEnd).toString("utf8") !== m.text) {
        problem = `the file changed after ast-grep read it (line ${m.line}); run the rewrite again`;
        break;
      }
      const start = m.replaceStart ?? m.byteStart;
      const end = m.replaceEnd ?? m.byteEnd;
      if (end > bytes.length || start < lastEnd) {
        problem = `two matches overlap near line ${m.line}; make the pattern more specific`;
        break;
      }
      lastEnd = end;
    }
    if (problem !== null) {
      plans.push(fail(problem));
      continue;
    }
    const parts: Buffer[] = [];
    let cursor = 0;
    for (const m of edits) {
      const start = m.replaceStart ?? m.byteStart;
      const end = m.replaceEnd ?? m.byteEnd;
      parts.push(bytes.subarray(cursor, start), Buffer.from(m.replacement!, "utf8"));
      cursor = end;
    }
    parts.push(bytes.subarray(cursor));
    plans.push({
      absolute,
      display,
      matches: fileMatches.length,
      before,
      after: Buffer.concat(parts).toString("utf8"),
    });
  }
  return plans;
}

function renderDiff(changed: readonly RewriteFilePlan[]): string {
  let out = "";
  for (const p of changed) {
    const patch = createPatch(p.display, p.before, p.after!, "", "", { context: 2 });
    if (out.length + patch.length > PREVIEW_MAX_CHARS) {
      out += `\n... diff clipped (${changed.length} files in all)\n`;
      break;
    }
    out += patch;
  }
  return out;
}

function countMatches(plans: readonly RewriteFilePlan[]): number {
  return plans.reduce((sum, p) => sum + p.matches, 0);
}

function clipInline(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function buildResult(
  plans: readonly RewriteFilePlan[],
  mode: "dry-run" | "applied" | "apply-refused",
  diff: string,
  command: string[],
): CompressedToolResult {
  const header =
    mode === "dry-run"
      ? "rewrite dry-run (nothing written; apply=true writes it):"
      : mode === "applied"
        ? "rewrite applied:"
        : "rewrite REFUSED, nothing was written; these files cannot be changed:";
  const lines = [header];
  for (const p of plans) {
    const mark = p.reason === undefined ? "✓" : "✗";
    const bits = [`${mark} ${p.display}`, `${p.matches} match${p.matches === 1 ? "" : "es"}`];
    if (p.reason !== undefined) bits.push(p.reason);
    lines.push(`  ${bits.join("  ")}`);
  }
  if (diff.length > 0 && mode !== "apply-refused") lines.push("", diff);
  return compressToolResult(
    {
      tool: TOOL,
      status: mode === "apply-refused" ? "error" : "ok",
      output: lines.join("\n"),
      details: {
        mode,
        files: plans.map((p) => ({
          path: p.display,
          absolute: p.absolute,
          matches: p.matches,
          applicable: p.reason === undefined,
          ...(p.reason !== undefined ? { reason: p.reason } : {}),
        })),
        totals: { files: plans.length, matches: countMatches(plans) },
        anyFailed: plans.some((p) => p.reason !== undefined),
        command,
      },
    },
    { maxSummaryLength: 32 * 1024, maxTailLines: 1000 },
  );
}

function errorResult(message: string, details: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({ tool: TOOL, status: "error", output: message, details });
}
