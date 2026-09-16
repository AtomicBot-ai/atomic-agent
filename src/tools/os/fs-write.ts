import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import { categorizeFsMutation } from "./fs-approval-scope.js";
import { checkChangedFile } from "./fs-content-check.js";
import {
  checkInputReplacement,
  refuseInputReplacement,
} from "./fs-input-guard.js";
import { PARSE_CHECK_MAX_CHARS, withParseWarning } from "./fs-parse-check.js";
import {
  NO_REPLACE_NOTE,
  countLines,
  formatBytes,
  formatLines,
  formatNumber,
  guardReplacedFile,
  readPriorFile,
  withReplaceNotes,
  type PriorFile,
} from "./fs-replace-guard.js";
import type { FileRestoreStore } from "./fs-restore-store.js";
import {
  requireFsApproval,
  type FsDangerousToolOptions,
} from "./fs-require-approval.js";
import type { ToolDefinition } from "../tool-registry.js";

/**
 * How many times one write may be retargeted from the approval prompt
 * before the tool refuses. Each hop is a deliberate keystroke by the
 * operator, so this is a runaway guard for a misbehaving host that
 * echoes an override back forever — not a limit anyone types into.
 */
const MAX_REDIRECTS = 3;

export function buildOsFsWriteTool(
  options: FsDangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.fs.write",
    description:
      "Write text content to a file (creating parents). Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const path = rawArgs.path;
      const content = rawArgs.content;
      if (typeof path !== "string" || path.length === 0) {
        throw new Error("os.fs.write: `path` must be a non-empty string");
      }
      if (typeof content !== "string") {
        throw new Error("os.fs.write: `content` must be a string");
      }
      const mode =
        typeof rawArgs.mode === "string" && rawArgs.mode === "append"
          ? "append"
          : "replace";
      const overwrite = rawArgs.overwrite === true;
      const absolute = resolveUserPath(path, ctx.workingDir);

      // A file the request names as an input is not replaced without
      // `overwrite: true` (F51, `fs-input-guard.ts`). Decided on the
      // model's own target before the operator is asked, so no prompt is
      // raised for a write that will not run; a target the operator
      // moves the write to from the prompt is their choice.
      if (mode === "replace") {
        const existing = await readPriorFile(absolute);
        if (existing !== null) {
          const refused = await checkInputReplacement({
            store: options.restore,
            sessionId: ctx.sessionId,
            absolute,
            display: path,
            prior: existing,
            after: content,
            request: options.resolveOriginalRequest?.(ctx.sessionId),
            overwrite,
          });
          if (refused !== null) return refuseInputReplacement("os.fs.write", refused);
        }
      }

      const preview =
        content.length > 400 ? `${content.slice(0, 400)}…` : content;

      // The operator can retarget the write from the prompt ("put it in
      // ~/Documents/apple-site instead"). A retarget is never a silent
      // widening of what they approved: the new path is re-categorised,
      // and only a target on the SAME rung of the ladder rides the
      // approval just given. A different rung goes round the loop and
      // prompts again for the new path; the agent's own config / `.env`
      // is refused outright, since that is the one surface the ladder
      // exists to protect and no prompt is offered for it here.
      let target = absolute;
      let redirects = 0;
      for (;;) {
        const outcome = await requireFsApproval(
          options,
          {
            kind: "write",
            paths: [target],
            sessionId: ctx.sessionId,
            tool: "os.fs.write",
            reason: `${mode} ${content.length} bytes into ${target}`,
            preview,
            affectedResources: [target],
            redirectablePath: target,
            workingDir: ctx.workingDir,
            trustConfigPaths: options.trustConfigPaths,
          },
          ctx.signal,
        );
        if (outcome.pathOverride === undefined) break;

        const typed = outcome.pathOverride.trim();
        if (typed.length === 0) {
          throw new Error(
            "os.fs.write: empty target path from the approval prompt",
          );
        }
        if (++redirects > MAX_REDIRECTS) {
          throw new Error(
            `os.fs.write: target redirected more than ${MAX_REDIRECTS} times`,
          );
        }
        const next = resolveUserPath(typed, ctx.workingDir);
        const nextCategory = await categorizeFsMutation("write", [next], {
          workingDir: ctx.workingDir,
          ...(options.trustConfigPaths !== undefined
            ? { trustConfigPaths: options.trustConfigPaths }
            : {}),
        });
        if (nextCategory === "trust_config") {
          throw new Error(
            `os.fs.write: refusing to redirect into the agent's own config: ${next}`,
          );
        }
        target = next;
        if (nextCategory === outcome.category) break;
      }

      // What is there now, read before it is gone: the line counts the
      // result reports, and — for a user's file about to be replaced —
      // the content the restore copy is taken from.
      const prior = await readPriorFile(target);
      await mkdir(dirname(target), { recursive: true });
      if (mode === "append") {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(target, content, "utf8");
      } else {
        await writeFile(target, content, "utf8");
      }
      const guard =
        prior === null
          ? await noteCreated(options.restore, ctx.sessionId, target)
          : mode === "replace"
            ? await guardReplacedFile({
                store: options.restore,
                sessionId: ctx.sessionId,
                workingDir: ctx.workingDir,
                absolute: target,
                display: target === absolute ? path : target,
                tool: "os.fs.write",
                change: "replace",
                prior,
                after: content,
              })
            : NO_REPLACE_NOTE;
      const parseWarning = await parseWarningAfterWrite(
        target,
        mode,
        content,
        ctx.workingDir,
      );
      const linesAfter = countLines(content);
      // The path is echoed in `output` (not just `details`) so a model
      // that had its target moved reads where the file actually landed
      // and keeps working against the right path.
      const wording = describeWrite(mode, prior, linesAfter);
      return withReplaceNotes(
        withParseWarning(
          compressToolResult({
            tool: "os.fs.write",
            status: "ok",
            output:
              target === absolute
                ? `wrote ${content.length} bytes to ${target} (${wording})`
                : `wrote ${content.length} bytes to ${target} (${wording}); the operator moved this write from ${absolute}`,
            details: {
              path: target,
              bytes: content.length,
              mode,
              lines: linesAfter,
              existed: prior !== null,
              ...(overwrite ? { overwrite: true } : {}),
              ...(prior === null ? {} : { previousBytes: prior.bytes }),
              ...(prior?.lines === undefined || prior.lines === null
                ? {}
                : { previousLines: prior.lines }),
              ...(target === absolute ? {} : { requestedPath: absolute }),
            },
          }),
          parseWarning,
        ),
        [guard],
      );
    },
  };
}

/**
 * The parenthetical after "wrote N bytes to path": `(replace)` used to
 * be all a model read when it overwrote a 2,401-line dataset with 10
 * lines, so the counts ride along — `(replace, 2,401 lines → 10)`,
 * `(replace, new file, 10 lines)`, `(replace, 12.3 MB → 10 lines)` for
 * a file too large to read. An append is judged on the chunk only.
 */
function describeWrite(
  mode: "append" | "replace",
  prior: PriorFile | null,
  linesAfter: number,
): string {
  if (mode === "append") return "append";
  if (prior === null) return `replace, new file, ${formatLines(linesAfter)}`;
  if (prior.lines === null) {
    return `replace, ${formatBytes(prior.bytes)} → ${formatLines(linesAfter)}`;
  }
  return `replace, ${formatLines(prior.lines)} → ${formatNumber(linesAfter)}`;
}

/** Remember that this session created `target`, so replacing it later is not a loss. Best effort. */
async function noteCreated(
  store: FileRestoreStore | undefined,
  sessionId: string,
  target: string,
): Promise<typeof NO_REPLACE_NOTE> {
  if (store !== undefined) {
    try {
      await store.recordCreated(sessionId, target);
    } catch {
      // The write already landed; a manifest that could not be written
      // only means a later replacement is announced when it need not be.
    }
  }
  return NO_REPLACE_NOTE;
}

/**
 * Check what now sits at `target` (see `fs-parse-check.ts` and
 * `fs-content-check.ts`). An append is judged on the whole file, not the
 * chunk. Any failure to check is silence: the write already succeeded
 * and is reported as such.
 */
async function parseWarningAfterWrite(
  target: string,
  mode: "append" | "replace",
  content: string,
  workingDir: string,
): Promise<string | null> {
  try {
    let written = content;
    if (mode === "append") {
      if ((await stat(target)).size > PARSE_CHECK_MAX_CHARS) return null;
      written = await readFile(target, "utf8");
    }
    return checkChangedFile({
      absolute: target,
      workingDir,
      change: "write",
      after: written,
    });
  } catch {
    return null;
  }
}
