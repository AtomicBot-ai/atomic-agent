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

export type TuiArgsResult = TuiArgs | { error: string };

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
