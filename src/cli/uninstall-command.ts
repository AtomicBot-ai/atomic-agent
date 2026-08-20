import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { getConfig } from "../config/index.js";
import { canSelfUpdate } from "../update/index.js";
import {
  buildUninstallPlan,
  DEFAULT_UNINSTALL_SCOPES,
  formatUninstallOutcome,
  formatUninstallPlan,
  installDirFromExecPath,
  isEmptyPlan,
  runUninstall,
  UNINSTALL_SCOPES,
  type UninstallScope,
} from "../uninstall/index.js";

const HELP =
  [
    "atomic-agent uninstall — remove Atomic Agent from this machine",
    "",
    "Removes the binary and the asset trees installed beside it, and drops",
    "the PATH line the installer appended to your shell config. Your state",
    "directory (config, sessions, memory, secrets, downloaded models) is",
    "KEPT unless you ask for it: reinstalling then picks up where you left",
    "off. Pass --state or --all to erase it.",
    "",
    "Usage:",
    "  atomic-agent uninstall [scopes] [--dry-run] [--yes]",
    "",
    "Scopes (default: --app --path):",
    "  --app        The binary plus grammars/, vendor/, node_modules/, and",
    "               the other trees the installer wrote next to it",
    "  --path       The `# added by atomic-agent installer` PATH block in",
    "               .zshrc / .bashrc / .bash_profile / .profile / fish",
    "  --state      The state directory — config, sessions, memory, API",
    "               keys in plaintext, and any downloaded model weights.",
    "               NOT reversible",
    "  --all        Every scope above",
    "",
    "Options:",
    "  --dry-run    Print exactly what would be removed and exit. Changes",
    "               nothing",
    "  --yes, -y    Skip the confirmation prompt (for scripts)",
    "",
    "Examples:",
    "  atomic-agent uninstall --dry-run --all",
    "  atomic-agent uninstall",
    "  atomic-agent uninstall --all --yes",
    "",
    "Note: the install directory itself is never deleted when it holds",
    "other programs (~/.local/bin is shared) — only the files listed are.",
  ].join("\n") + "\n";

interface ParsedArgs {
  readonly scopes: readonly UninstallScope[];
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly help: boolean;
  readonly error?: string;
}

export function parseUninstallArgs(args: readonly string[]): ParsedArgs {
  const scopes = new Set<UninstallScope>();
  let dryRun = false;
  let yes = false;
  let help = false;

  for (const arg of args) {
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
      case "-y":
        yes = true;
        break;
      case "--all":
        for (const scope of UNINSTALL_SCOPES) scopes.add(scope);
        break;
      case "--app":
        scopes.add("app");
        break;
      case "--path":
        scopes.add("path");
        break;
      case "--state":
        scopes.add("state");
        break;
      default:
        return {
          scopes: [],
          dryRun,
          yes,
          help,
          error: `unknown option: ${arg}`,
        };
    }
  }

  return {
    scopes: scopes.size > 0 ? [...scopes] : DEFAULT_UNINSTALL_SCOPES,
    dryRun,
    yes,
    help,
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = (
      await new Promise<string>((resolve) => rl.question(question, resolve))
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function uninstallCommand(args: string[]): Promise<number> {
  const parsed = parseUninstallArgs(args);
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${HELP}`);
    return 2;
  }

  const config = getConfig();
  const stateDir = config.paths.stateDir;
  const installDir = installDirFromExecPath(process.execPath);

  // Running under `node` / `tsx` in a dev checkout: execPath is the Node
  // binary, so "the files beside it" are Node's, not ours. Refuse the app
  // scope rather than offering to delete someone's Node install.
  const installed = canSelfUpdate();
  const scopes = installed
    ? parsed.scopes
    : parsed.scopes.filter((s) => s !== "app");

  if (!installed && parsed.scopes.includes("app")) {
    process.stderr.write(
      "note: not running from an installed binary (this looks like a dev\n" +
        "      checkout), so the --app scope is skipped. Remove the checkout\n" +
        "      by hand.\n\n",
    );
  }

  const plan = buildUninstallPlan({
    scopes,
    installDir,
    stateDir,
    exists: existsSync,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  });

  process.stdout.write(`${formatUninstallPlan(plan)}\n`);

  if (parsed.dryRun) {
    process.stdout.write("\nDry run — nothing was changed.\n");
    return 0;
  }

  if (isEmptyPlan(plan)) return 0;

  if (!parsed.yes) {
    const erasesData = plan.scopes.includes("state");
    const question = erasesData
      ? "\nThis permanently deletes your sessions, memory and API keys. Continue? [y/N] "
      : "\nProceed? [y/N] ";
    const ok = await confirm(question);
    if (!ok) {
      process.stdout.write("Aborted — nothing was changed.\n");
      return 1;
    }
  }

  const outcome = runUninstall(plan);
  process.stdout.write(`\n${formatUninstallOutcome(outcome)}\n`);

  if (outcome.failures.length > 0) {
    process.stderr.write(
      "\nsome items could not be removed (see 'failed' lines above); " +
        "remove them by hand or re-run with sufficient permissions\n",
    );
    return 1;
  }

  if (outcome.edited.length > 0) {
    process.stdout.write(
      "\nPATH was edited — open a new terminal for it to take effect.\n",
    );
  }
  process.stdout.write("\nAtomic Agent has been removed. Thanks for trying it.\n");
  return 0;
}
