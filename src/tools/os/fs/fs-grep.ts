import { OS_FS_GREP_CONTRACT } from "./fs-grep-contract.js";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import { runCommand as defaultRunCommand } from "../../../sandbox/command-runner.js";
import {
  resolveRipgrepPath,
  RIPGREP_MISSING_HINT,
} from "../../../runtime/ripgrep-resolver.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  buildRgArgs,
  parseArgs,
  resolveSearchTarget,
  type SearchTarget,
} from "./fs-grep-args.js";
import { formatGrepResult } from "./fs-grep-format.js";
import { parseRipgrepJson } from "./fs-grep-ripgrep-json.js";
import { withTimeoutNote } from "./fs-grep-timeout.js";

export type { GrepOutputMode } from "./fs-grep-args.js";
export { parseRipgrepJson } from "./fs-grep-ripgrep-json.js";

export interface FsGrepDependencies {
  resolveRgPath: () => string | null;
  runCommand: typeof defaultRunCommand;
}

/**
 * ripgrep's wording when the pattern is not a valid regex — `.add(`,
 * `foo[`, `a**`. Models reach for grep with a code fragment more often
 * than with a regex, so the error names the flag that searches for the
 * fragment as written.
 */
const REGEX_PARSE_ERROR = /regex parse error/i;
export const LITERAL_HINT =
  "the pattern was parsed as a regex; to search for it as a fixed string, set `literal: true`";

export function buildOsFsGrepTool(
  deps: Partial<FsGrepDependencies> = {},
): ToolDefinition {
  const resolveRgPath = deps.resolveRgPath ?? (() => resolveRipgrepPath());
  const runCommand = deps.runCommand ?? defaultRunCommand;

  return {
    name: OS_FS_GREP_CONTRACT.name,
    description: OS_FS_GREP_CONTRACT.description,
    readonly: OS_FS_GREP_CONTRACT.readonly,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs, ctx.workingDir);
      const rgPath = resolveRgPath();
      if (!rgPath) {
        return compressToolResult({
          tool: "os.fs.grep",
          status: "error",
          output: RIPGREP_MISSING_HINT,
          details: { missing: true, hint: RIPGREP_MISSING_HINT },
        });
      }

      let target: SearchTarget;
      try {
        target = await resolveSearchTarget(args.path, ctx.workingDir);
      } catch (err) {
        const reason = (err as Error).message;
        return compressToolResult({
          tool: "os.fs.grep",
          status: "error",
          output: reason,
          details: { path: args.path, hint: reason },
        });
      }

      const rgArgs = buildRgArgs(args, target.searchTarget);
      // The runner only listens for an abort that happens after spawn.
      ctx.signal.throwIfAborted();
      const result = await runCommand(rgPath, rgArgs, {
        cwd: target.cwd,
        timeoutMs: args.timeoutMs,
        signal: ctx.signal,
      });
      // The runner resolves on abort with whatever it captured; a
      // cancelled search is not a result, so it rejects like other fs tools.
      ctx.signal.throwIfAborted();

      // Checked before the exit code: a killed ripgrep reports `null`,
      // and the matches it already printed are still worth returning.
      if (result.timedOut) {
        const files = parseRipgrepJson(result.stdout);
        return withTimeoutNote(
          formatGrepResult(args, files, rgPath, rgArgs, result),
          { elapsedMs: result.durationMs },
        );
      }

      // ripgrep exits 1 on no matches, 0 on matches, 2+ on error.
      if (result.exitCode === 1) {
        return compressToolResult({
          tool: "os.fs.grep",
          status: "ok",
          output: "(no matches)",
          details: {
            totals: { files: 0, matches: 0 },
            files: [],
            truncated: false,
            command: [rgPath, ...rgArgs],
            path: args.path,
          },
        });
      }
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        const reason =
          stderr.length > 0
            ? stderr
            : `ripgrep exited with code ${result.exitCode}`;
        const hint =
          !args.literal && REGEX_PARSE_ERROR.test(stderr) ? LITERAL_HINT : null;
        return compressToolResult({
          tool: "os.fs.grep",
          status: "error",
          output: hint === null ? reason : `${reason}\nhint: ${hint}`,
          details: {
            exitCode: result.exitCode,
            command: [rgPath, ...rgArgs],
            path: args.path,
            ...(hint === null ? {} : { hint }),
          },
        });
      }

      const files = parseRipgrepJson(result.stdout);
      return formatGrepResult(args, files, rgPath, rgArgs, result);
    },
  };
}
