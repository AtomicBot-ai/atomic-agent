import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { runCommand } from "../../sandbox/command-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";

export function buildOsShellTool(options: DangerousToolOptions): ToolDefinition {
  return {
    name: "os.shell.run",
    description:
      "Run an OS command in the session working directory. Dangerous — always requires approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const cmd = rawArgs.cmd;
      if (typeof cmd !== "string" || cmd.length === 0) {
        throw new Error("os.shell.run: `cmd` must be a non-empty string");
      }
      const args = Array.isArray(rawArgs.args)
        ? rawArgs.args.map((v) => String(v))
        : [];
      const cwd =
        typeof rawArgs.cwd === "string" && rawArgs.cwd.length > 0
          ? rawArgs.cwd
          : ctx.workingDir;
      const timeoutMs =
        typeof rawArgs.timeoutMs === "number" &&
        Number.isFinite(rawArgs.timeoutMs)
          ? rawArgs.timeoutMs
          : 30_000;

      const commandLine = [cmd, ...args].join(" ");
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.shell.run",
          reason: `execute shell command in ${cwd}`,
          preview: commandLine,
          affectedResources: [cwd],
        },
        ctx.signal,
      );

      const result = await runCommand(cmd, args, {
        cwd,
        timeoutMs,
        signal: ctx.signal,
      });
      const status = result.exitCode === 0 ? "ok" : "error";
      const header = `$ ${commandLine}\nexit: ${result.exitCode ?? "signal:" + result.signal}${result.timedOut ? " (timed out)" : ""}`;
      const body = [result.stdout, result.stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n---\n");
      return compressToolResult({
        tool: "os.shell.run",
        status,
        output: `${header}\n${body}`,
        details: {
          cmd,
          args,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      });
    },
  };
}
