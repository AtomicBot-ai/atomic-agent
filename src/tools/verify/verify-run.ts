/**
 * `verify.run` — one tool to run what was built: a command, a service
 * or a page, against a throwaway copy of the working directory.
 *
 * Read-only from the workspace's point of view (the copy takes every
 * write), so the fusion orchestrator gate lets it run (decision D1). It
 * still executes things, so below the approval ladder's shell rung it
 * asks under the same category as `os.shell.run`; an authorised fan-out
 * scope covers it the way it covers a worker's shell command. At level
 * 5 (`--no-approval`) it runs without asking.
 *
 * The copy is not a sandbox, so every command it starts first passes
 * the shell guard (ATO-1266): a hardline or policy rule refuses the call
 * before anything runs, at every level; a `dangerous.*` match asks as
 * `shell_dangerous`, which no fan-out scope and no `shell` grant covers.
 */
import {
  requireApproval,
  savedRuleOverridesScope,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserLauncher } from "./run-page-kind.js";
import { runVerify } from "./run-verify.js";
import { parseVerifyRunArgs, type VerifyRunArgs } from "./verify-run-args.js";
import { needsShellInterpretation } from "../os/shell/shell-interpretation.js";
import {
  shellRuleSegments,
  shellRunsUnreadableScript,
} from "../os/shell/shell-command-argv.js";
import { guardVerifyCommand, guardVerifyRun, verifyRunCommands } from "./verify-run-guard.js";
import type { ToolSecretSource } from "../../config/tool-secrets.js";
import { describeToolSecretUse } from "../tool-secret-use.js";
import { checkVerifySecrets, fillVerifySecrets, withPlaceholderCommandLine } from "./verify-run-secrets.js";

export const VERIFY_RUN_TOOL = "verify.run";

export interface VerifyRunToolOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "browser">;
  /**
   * Operator policy for the shell guard (the git remote-sync switch),
   * the same predicates `os.shell.run` gets. Omitted by embedders and
   * tests, which then get the static rule set.
   */
  shellPolicy?: ShellGuardPolicy;
  /** Test seam: replaces the real browser launch. */
  launchBrowser?: BrowserLauncher;
  /** Tool secrets a command or `env` may name as `{{secret:NAME}}` (ATO-2530). Omitted: none. */
  secrets?: ToolSecretSource;
}

/** What the operator is asked to approve, in one line. */
export function describeVerifyRun(args: VerifyRunArgs): string {
  if (args.kind === "command") return [args.cmd, ...(args.args ?? [])].join(" ");
  if (args.kind === "service") {
    const start = [args.start?.cmd, ...(args.start?.args ?? [])].join(" ");
    return `start \`${start}\`, then ${args.requests?.length ?? 0} request(s)`;
  }
  const open = `open ${args.url ?? args.path} headless for ${args.seconds}s`;
  if (args.start === undefined) return open;
  return `start \`${[args.start.cmd, ...(args.start.args ?? [])].join(" ")}\`, then ${open}`;
}

export function buildVerifyRunTool(options: VerifyRunToolOptions): ToolDefinition {
  return {
    name: VERIFY_RUN_TOOL,
    description:
      "Run a check against a throwaway copy of the working directory — nothing it writes reaches the workspace (may require approval). kind 'command': any test runner, compiler or script ({cmd, args}). kind 'service': {start:{cmd,args}, ready:{port|url}, requests:[{method,path|url,body,expectStatus,expectBody}]}. kind 'page': a local HTML file ({path}) or {url} in a headless browser (with {start, url} the server is started first and the page opens once `ready` passes, by default when the url answers 2xx): {script:[{action:click|key|type|wait,…}]}, then `seconds` of runtime with `probes:[{name, expr}]` sampled every 250 ms; collects uncaught errors, console errors, failed getElementById/querySelector lookups. `checks`: `exit 0`, `exit != 0`, `stdout contains \"x\"`, `stderr not contains \"x\"`, `status 200`, `no errors`, `missing selectors 0`, `probe <name> decreases|increases|equals <v>|reaches <v>|stays <v>`. `network` defaults to false (a proxy-based soft block, not a sandbox). Results are capped: output tails of 8,000 chars, summary of 4,000.",
    readonly: true,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: VerifyRunArgs;
      try {
        args = parseVerifyRunArgs(rawArgs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { tool: VERIFY_RUN_TOOL, status: "error", summary: message, details: { error: message }, truncated: false };
      }
      const description = describeVerifyRun(args);
      // Same pre-exec guard as `os.shell.run` (ATO-1266): the copy takes
      // the writes inside it, not `rm -rf ~` or `sudo`.
      const guard = guardVerifyRun(args, ctx.workingDir, options.shellPolicy);
      if (guard.blocked !== null) {
        const { verdict } = guard.blocked;
        const message = `verify.run: blocked by shell guard: ${verdict.rule} - ${verdict.reason}`;
        return {
          tool: VERIFY_RUN_TOOL,
          status: "error",
          summary: message,
          details: {
            error: message,
            description,
            guardVerdict: verdict.action,
            guardRule: verdict.rule,
            guardReason: verdict.reason,
          },
          truncated: false,
        };
      }
      const dangerous = guard.dangerous.length > 0;
      // `{{secret:NAME}}` (ATO-2530): known names only, before any
      // question; such a run always asks, and no fan-out scope covers it.
      const secretUse = checkVerifySecrets(args, options.secrets);
      if (!secretUse.ok) {
        const message = `verify.run: ${secretUse.message}`;
        return { tool: VERIFY_RUN_TOOL, status: "error", summary: message, details: { error: message, description }, truncated: false };
      }
      const secretNames = secretUse.names;
      // A fan-out's directory covers ordinary checks, never a dangerous
      // command: the operator approved a directory of work, not those.
      const commandSegments = verifyRunCommands(args).flatMap((command) =>
        shellRuleSegments(
          command.cmd,
          command.args,
          needsShellInterpretation(command.cmd, command.args),
        ),
      );
      const commandUnreadable = verifyRunCommands(args).some((command) =>
        shellRunsUnreadableScript(
          command.cmd,
          command.args,
          needsShellInterpretation(command.cmd, command.args),
        ),
      );
      const scopedByFanout =
        !dangerous &&
        secretNames.length === 0 &&
        (options.approvals.fanoutScopes?.allows(ctx.sessionId, [ctx.workingDir]) ?? false) &&
        !savedRuleOverridesScope(options.approvals, {
          sessionId: ctx.sessionId,
          tool: VERIFY_RUN_TOOL,
          category: "shell",
          commandSegments,
          ...(commandUnreadable ? { commandUnreadable } : {}),
          affectedResources: [ctx.workingDir],
          workdir: ctx.workingDir,
        });
      if (!scopedByFanout) {
        const reason = dangerous
          ? `${guard.dangerous.map((c) => c.verdict.reason).join("; ")} — verify (${args.kind}) in a throwaway copy of ${ctx.workingDir}; the copy is not a sandbox`
          : `verify (${args.kind}) in a throwaway copy of ${ctx.workingDir}`;
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: VERIFY_RUN_TOOL,
            // Dangerous wins the label; a secret asks as `shell_secret`.
            category: dangerous ? "shell_dangerous" : secretNames.length > 0 ? "shell_secret" : "shell",
            reason: reason + describeToolSecretUse(secretNames),
            preview: description,
            affectedResources: [ctx.workingDir],
            commandSegments,
            ...(commandUnreadable ? { commandUnreadable } : {}),
            ...(guard.dangerous.some((c) => c.verdict.askEveryLevel === true)
              ? { askEveryLevel: true as const }
              : {}),
          },
          ctx.signal,
        );
      }
      // After approval, and only into what is spawned.
      let runArgs = args;
      if (secretNames.length > 0 && options.secrets !== undefined) {
        const filled = await fillVerifySecrets(args, secretNames, options.secrets, (before, after) => {
          const was = guardVerifyCommand(before.cmd, before.args, ctx.workingDir, options.shellPolicy);
          const now = guardVerifyCommand(after.cmd, after.args, ctx.workingDir, options.shellPolicy);
          return now.action === was.action && now.rule === was.rule;
        });
        if (!filled.ok) {
          const message = `verify.run: ${filled.message}`;
          return { tool: VERIFY_RUN_TOOL, status: "error", summary: message, details: { error: message, description }, truncated: false };
        }
        runArgs = filled.args;
      }
      const ran = await runVerify(runArgs, {
        workingDir: ctx.workingDir,
        config: options.config,
        signal: ctx.signal,
        ...(options.launchBrowser === undefined ? {} : { launchBrowser: options.launchBrowser }),
      });
      const result = runArgs === args ? ran : withPlaceholderCommandLine(ran, args, runArgs);
      const { summary, ...details } = result;
      return {
        tool: VERIFY_RUN_TOOL,
        status: result.ok ? "ok" : "error",
        summary,
        details: { ...details, description },
        truncated: summary.endsWith("[clipped]"),
      };
    },
  };
}
