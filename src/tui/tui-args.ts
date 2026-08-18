import { resolve } from "node:path";

/**
 * Parsed flags for the `atomic-agent tui` subcommand. Kept separate from
 * the orchestrator so argument handling can be unit-tested without
 * booting the Ink runtime.
 */
export interface TuiArgs {
  workingDir: string;
  maxSteps: number | null;
  noApproval: boolean;
  /** Skip the first-run llama-server setup wizard when /health fails. */
  skipLlamaSetup: boolean;
}

export type TuiArgsResult = TuiArgs | { error: string } | { help: true };

export const TUI_HELP =
  [
    "atomic-agent tui — the interactive terminal dashboard",
    "",
    "Usage:",
    "  atomic-agent tui [options]     (also the default when no command is given)",
    "",
    "Options:",
    "  --cwd <dir>          Working directory for OS tools (default: current directory)",
    "  --working-dir <dir>  Alias for --cwd",
    "  --max-steps <n>      Step budget per turn (default: agent.maxSteps from config)",
    "  --no-approval        Force approval level 5: auto-approve every dangerous tool call",
    "  --skip-llama-setup   Skip the first-run local-model setup gate",
    "",
    "Needs an interactive terminal; in scripts use `atomic-agent run`.",
  ].join("\n") + "\n";

/**
 * Parses the CLI arguments accepted by `tuiCommand`. Returns either the
 * parsed config or an `{ error }` discriminator the caller can print to
 * stderr.
 *
 * Supported flags:
 *   --cwd / --working-dir <path>   switch the session working directory
 *   --max-steps <n>                override the loop safety cap
 *   --no-approval                  force approval level 5 (approve everything) for this run
 *   --skip-llama-setup             skip the startup llama URL wizard
 */
export function parseTuiArgs(args: string[]): TuiArgsResult {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  let skipLlamaSetup = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "--help":
      case "-h":
        return { help: true };
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        workingDir = resolve(value);
        break;
      }
      case "--max-steps": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed)) return { error: "--max-steps expects an integer" };
        maxSteps = parsed;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      case "--skip-llama-setup":
        skipLlamaSetup = true;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return {
    workingDir: workingDir ?? process.cwd(),
    maxSteps,
    noApproval,
    skipLlamaSetup,
  };
}

/**
 * The one-sentence refusal for a stdin that is not a terminal, or `null`
 * when the TUI can mount. A pipe (CI, cron, `echo hi | atomic-agent`, a
 * Dockerfile RUN) used to reach Ink's raw-mode requirement and die with a
 * React stack trace of minified bundle offsets — and bare `atomic-agent` /
 * `atomic-agent tui` are exactly the commands new users and scripts run
 * first. Lives here rather than in tui-command.ts so it is unit-testable:
 * that module imports the SEA bridge, which vitest cannot load.
 */
export function nonInteractiveStdinError(
  stdin: { isTTY?: boolean } = process.stdin,
): string | null {
  if (stdin.isTTY) return null;
  return "atomic-agent needs an interactive terminal — use 'atomic-agent run' for scripts.";
}

