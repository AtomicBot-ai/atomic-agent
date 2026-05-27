import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { runCommand } from "../../sandbox/command-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import { resolveUserPath } from "./expand-home.js";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";
import {
  checkShellCommandGuard,
  isGogCommand,
} from "./shell-command-guard/index.js";

const GOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GOG_COMPRESS_OPTIONS = {
  maxSummaryLength: 64_000,
  maxTailLines: 10_000,
} as const;

export function buildOsShellTool(options: DangerousToolOptions): ToolDefinition {
  return {
    name: "os.shell.run",
    description:
      "Run an OS command in the session working directory (argv globs `*`/`?` are expanded like a shell; no implicit subshell). Do not use for deleting user files — use `os.fs.trash` unless the user explicitly requests permanent shell deletion. Runs through a pre-exec guard: safe commands run directly, risky commands require approval, catastrophic commands are blocked without execution.",
    readonly: false,
    async run(rawArgs, ctx) {
      const cmd = rawArgs.cmd;
      if (typeof cmd !== "string" || cmd.length === 0) {
        throw new Error("os.shell.run: `cmd` must be a non-empty string");
      }
      const rawArgList = Array.isArray(rawArgs.args)
        ? rawArgs.args.map((v) => String(v))
        : [];
      const cwd =
        typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
          ? resolveUserPath(rawArgs.cwd, ctx.workingDir)
          : ctx.workingDir;
      const timeoutMs =
        typeof rawArgs.timeoutMs === "number" &&
        Number.isFinite(rawArgs.timeoutMs)
          ? rawArgs.timeoutMs
          : 30_000;

      const guardVerdict = checkShellCommandGuard({
        cmd,
        rawArgs: rawArgList,
        cwd,
      });
      if (guardVerdict.action === "block") {
        return compressToolResult({
          tool: "os.shell.run",
          status: "error",
          output: `blocked by shell guard: ${guardVerdict.rule} - ${guardVerdict.reason}`,
          details: {
            cmd,
            rawArgs: rawArgList,
            cwd,
            guardVerdict: guardVerdict.action,
            guardRule: guardVerdict.rule,
            guardReason: guardVerdict.reason,
          },
        });
      }

      const args = expandShellGlobArgs(cmd, rawArgList, cwd);
      const commandLine = [cmd, ...args].join(" ");
      if (guardVerdict.action === "approval_required") {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.shell.run",
            reason: `${guardVerdict.reason} in ${cwd}`,
            preview: commandLine,
            affectedResources: [cwd],
          },
          ctx.signal,
        );
      }

      const result = await runCommand(cmd, args, {
        cwd,
        timeoutMs,
        signal: ctx.signal,
        ...(isGogCommand(cmd) ? { maxOutputBytes: GOG_MAX_OUTPUT_BYTES } : {}),
      });
      const status = result.exitCode === 0 ? "ok" : "error";
      const header = `$ ${commandLine}\nexit: ${result.exitCode ?? "signal:" + result.signal}${result.timedOut ? " (timed out)" : ""}`;
      const body = [result.stdout, result.stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n---\n");
      return compressToolResult(
        {
          tool: "os.shell.run",
          status,
          output: `${header}\n${body}`,
          details: {
            cmd,
            args,
            rawArgs: rawArgList,
            cwd,
            exitCode: result.exitCode,
            signal: result.signal,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            truncated: result.truncated,
            guardVerdict: guardVerdict.action,
            guardRule: guardVerdict.rule,
            guardReason: guardVerdict.reason,
          },
        },
        isGogCommand(cmd) ? GOG_COMPRESS_OPTIONS : {},
      );
    },
  };
}
