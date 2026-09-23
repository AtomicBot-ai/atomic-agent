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
 */
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { BrowserLauncher } from "./run-page-kind.js";
import { runVerify } from "./run-verify.js";
import { parseVerifyRunArgs, type VerifyRunArgs } from "./verify-run-args.js";

export const VERIFY_RUN_TOOL = "verify.run";

export interface VerifyRunToolOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "browser">;
  /** Test seam: replaces the real browser launch. */
  launchBrowser?: BrowserLauncher;
}

/** What the operator is asked to approve, in one line. */
export function describeVerifyRun(args: VerifyRunArgs): string {
  if (args.kind === "command") return [args.cmd, ...(args.args ?? [])].join(" ");
  if (args.kind === "service") {
    const start = [args.start?.cmd, ...(args.start?.args ?? [])].join(" ");
    return `start \`${start}\`, then ${args.requests?.length ?? 0} request(s)`;
  }
  return `open ${args.url ?? args.path} headless for ${args.seconds}s`;
}

export function buildVerifyRunTool(options: VerifyRunToolOptions): ToolDefinition {
  return {
    name: VERIFY_RUN_TOOL,
    description:
      "Run a check against a throwaway copy of the working directory — nothing it writes reaches the workspace (may require approval). kind 'command': any test runner, compiler or script ({cmd, args}). kind 'service': {start:{cmd,args}, ready:{port|url}, requests:[{method,path|url,body,expectStatus,expectBody}]}. kind 'page': a local HTML file ({path}) or {url} in a headless browser: {script:[{action:click|key|type|wait,…}]}, then `seconds` of runtime with `probes:[{name, expr}]` sampled every 250 ms; collects uncaught errors, console errors, failed getElementById/querySelector lookups. `checks`: `exit 0`, `exit != 0`, `stdout contains \"x\"`, `stderr not contains \"x\"`, `status 200`, `no errors`, `missing selectors 0`, `probe <name> decreases|increases|equals <v>|reaches <v>|stays <v>`. `network` defaults to false (a proxy-based soft block, not a sandbox). Results are capped: output tails of 8,000 chars, summary of 4,000.",
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
      const scopedByFanout =
        options.approvals.fanoutScopes?.allows(ctx.sessionId, [ctx.workingDir]) ?? false;
      if (!scopedByFanout) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: VERIFY_RUN_TOOL,
            category: "shell",
            reason: `verify (${args.kind}) in a throwaway copy of ${ctx.workingDir}`,
            preview: description,
            affectedResources: [ctx.workingDir],
          },
          ctx.signal,
        );
      }
      const result = await runVerify(args, {
        workingDir: ctx.workingDir,
        config: options.config,
        signal: ctx.signal,
        ...(options.launchBrowser === undefined ? {} : { launchBrowser: options.launchBrowser }),
      });
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
