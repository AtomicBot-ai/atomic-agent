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
  /**
   * Terminal mouse reporting override. `null` defers to `tui.mouse` in
   * the user config; `false` (`--no-mouse`) keeps the terminal's own
   * text selection for this run.
   */
  mouse: boolean | null;
  /**
   * Dev testing ground for the update surfaces: pretend this version is
   * available on GitHub Releases. Skips the real check (and the real
   * installer on accept), so the modal, the status-bar banner and their
   * degradations can be eyeballed without publishing a release or
   * running a stale binary. `null` in normal operation.
   */
  fakeUpdateVersion: string | null;
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
    "  --mouse              Force terminal mouse support on for this run",
    "  --no-mouse           Disable mouse support; restores drag-to-select",
    "  --fake-update <ver>  Dev: pretend version <ver> is released (no real install)",
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
 *   --mouse / --no-mouse           force mouse reporting on / off
 */
export function parseTuiArgs(args: string[]): TuiArgsResult {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  let skipLlamaSetup = false;
  let mouse: boolean | null = null;
  let fakeUpdateVersion: string | null = null;
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
      case "--mouse":
        mouse = true;
        break;
      case "--no-mouse":
        mouse = false;
        break;
      case "--fake-update": {
        const value = args[++i];
        // A bare version, not a flag that happened to follow. Catching
        // `--fake-update --no-mouse` here beats a banner advertising
        // "v--no-mouse" ten minutes into a test session.
        if (!value || value.startsWith("-"))
          return { error: "--fake-update requires a version (e.g. --fake-update 9.9.9)" };
        fakeUpdateVersion = value.replace(/^v/, "");
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return {
    workingDir: workingDir ?? process.cwd(),
    maxSteps,
    noApproval,
    skipLlamaSetup,
    mouse,
    fakeUpdateVersion,
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

