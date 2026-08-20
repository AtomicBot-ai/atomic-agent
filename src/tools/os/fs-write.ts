import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { resolveUserPath } from "./expand-home.js";
import { categorizeFsMutation } from "./fs-approval-scope.js";
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
      const absolute = resolveUserPath(path, ctx.workingDir);

      const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content;

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
          throw new Error("os.fs.write: empty target path from the approval prompt");
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

      await mkdir(dirname(target), { recursive: true });
      if (mode === "append") {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(target, content, "utf8");
      } else {
        await writeFile(target, content, "utf8");
      }
      // The path is echoed in `output` (not just `details`) so a model
      // that had its target moved reads where the file actually landed
      // and keeps working against the right path.
      return compressToolResult({
        tool: "os.fs.write",
        status: "ok",
        output:
          target === absolute
            ? `wrote ${content.length} bytes to ${target} (${mode})`
            : `wrote ${content.length} bytes to ${target} (${mode}); the operator moved this write from ${absolute}`,
        details: {
          path: target,
          bytes: content.length,
          mode,
          ...(target === absolute ? {} : { requestedPath: absolute }),
        },
      });
    },
  };
}
