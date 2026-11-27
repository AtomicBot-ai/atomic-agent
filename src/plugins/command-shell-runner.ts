import { ApprovalDeniedError } from "../approval/dangerous-tool.js";
import { runWithApprovalWorkdir } from "../approval/approval-workdir.js";
import { activePolicy } from "../policy/policy-active.js";
import { policyCallRefusal } from "../policy/policy-enforce.js";
import type { EffectivePolicy } from "../policy/policy-evaluator.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import { CommandShellRefused, type CommandShellRunner } from "./command-shell.js";

/**
 * The production runner for a command's shell lines (ATO-2441): every
 * line is one `os.shell.run` call through the tool registry, so it goes
 * through exactly what a model's call goes through at dispatch: the
 * shell guard, the approval gate (level, grants, saved rules, egress
 * hold, security rules), Safe Mode's sandbox and secret masking. The
 * organization policy check is the one the dispatcher runs before the
 * registry, done here as the MCP bridge does (`cli/mcp-server-bridge.ts`).
 * Precedent: Claude Code runs a command's `!` lines through its own
 * Bash permission check; Gemini CLI asks before a `!{}` runs.
 */
export interface RegistryShellRunnerDeps {
  registry: Pick<ToolRegistry, "invoke">;
  /** The chat the person is looking at: its approval surface asks, its grants answer. */
  sessionId: string;
  workingDir: string;
  signal?: AbortSignal;
  policy?: () => EffectivePolicy;
}

export const COMMAND_SHELL_TIMEOUT_MS = 60_000;

export function createRegistryShellRunner(deps: RegistryShellRunnerDeps): CommandShellRunner {
  return async (command) => {
    const args = { cmd: command, timeoutMs: COMMAND_SHELL_TIMEOUT_MS };
    if (policyCallRefusal((deps.policy ?? activePolicy)(), "os.shell.run", args) !== null) {
      throw new CommandShellRefused(command, "is blocked by your organization's policy");
    }
    let result;
    try {
      result = await runWithApprovalWorkdir(deps.workingDir, () => deps.registry.invoke("os.shell.run", args, {
        workingDir: deps.workingDir,
        sessionId: deps.sessionId,
        stepIndex: 0,
        signal: deps.signal ?? new AbortController().signal,
        // The whole output, not the local model's short preview.
        modelMode: "cloud",
      }));
    } catch (err) {
      if (err instanceof ApprovalDeniedError) {
        throw new CommandShellRefused(command, err.byUser ? "was not allowed" : "was refused without an answer");
      }
      throw new CommandShellRefused(command, `could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.status === "error") {
      throw new CommandShellRefused(command, `failed:\n${lastLines(result.summary, 12)}`);
    }
    return shellOutputBody(result.summary);
  };
}

/**
 * What the command printed: the shell result without its own `$ line`
 * and `exit: 0` header (`tools/os/shell/shell-result.ts`), or the whole
 * summary when it does not have that shape.
 */
export function shellOutputBody(summary: string): string {
  const lines = summary.split("\n");
  const header = lines.findIndex((line, i) => line.startsWith("$ ") && (lines[i + 1] ?? "").startsWith("exit: "));
  return header === -1 || header > 8 ? summary : lines.slice(header + 2).join("\n");
}

function lastLines(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}
