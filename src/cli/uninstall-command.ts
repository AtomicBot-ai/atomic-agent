import { createInterface } from "node:readline/promises";

import { getConfig } from "../config/index.js";
import {
  formatBytes,
  resolveUninstallPlan,
  runUninstall,
  type ResolvedUninstallPlan,
} from "../uninstall/index.js";

/**
 * The word the operator has to type out. Not `y`: every other confirm
 * in this CLI is a `[y/N]`, and muscle memory answers those without
 * reading. A word that has to be spelled is the cheapest way to make
 * the last keystroke a decision rather than a reflex.
 */
const CONFIRM_WORD = "uninstall";

export interface UninstallCommandDeps {
  resolvePlan?: typeof resolveUninstallPlan;
  run?: typeof runUninstall;
  getStateDir?: () => string;
  /** Defaults to stdin *and* stdout being a TTY — see `update-command.ts`. */
  isTTY?: () => boolean;
  /** Free-text prompt. Defaults to a readline question. */
  ask?: (prompt: string) => Promise<string>;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
}

const HELP = [
  "atomic-agent uninstall — remove atomic-agent and its data from this machine",
  "",
  "Deletes the state directory (config, memory, sessions, tasks, traces and any",
  "downloaded GGUF models), the installed binary and its `atag` alias, the asset",
  "directories the installer put beside them, and the PATH line install.sh added",
  "to your shell rc file.",
  "",
  "This cannot be undone. There is no backup. Nothing is uploaded anywhere, and",
  "nothing is kept — after this the only trace of atomic-agent on the machine is",
  "whatever you copied out yourself.",
  "",
  "Interactive runs print the full list with sizes and then ask you to type the",
  `word \`${CONFIRM_WORD}\`. Non-interactive runs must pass --yes.`,
  "",
  "Flags:",
  "  --dry-run            Print exactly what would be removed, remove nothing",
  "  --keep-data          Keep the state directory; remove only the program",
  "  --keep-binary        Keep the binary; remove only the data",
  "  --keep-path          Leave the installer's PATH line in your rc file",
  "  -y, --yes            Skip the typed confirmation (for scripts)",
  "  -h, --help           Show this help",
  "",
  "Exit codes:",
  "  0  success (removed, or --dry-run printed the plan, or you declined)",
  "  1  operational failure (something could not be removed)",
  "  2  usage error (unknown flag, or no TTY and no --yes)",
  "",
  "Examples:",
  "  atomic-agent uninstall --dry-run",
  "  atomic-agent uninstall",
  "  atomic-agent uninstall --keep-data      # reinstall later, keep your memory",
].join("\n") + "\n";

interface UninstallFlags {
  dryRun: boolean;
  keepData: boolean;
  keepBinary: boolean;
  keepPath: boolean;
  yes: boolean;
  help: boolean;
}

function parseArgs(
  args: string[],
): { ok: true; flags: UninstallFlags } | { ok: false; error: string } {
  const flags: UninstallFlags = {
    dryRun: false,
    keepData: false,
    keepBinary: false,
    keepPath: false,
    yes: false,
    help: false,
  };
  for (const arg of args) {
    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--keep-data":
        flags.keepData = true;
        break;
      case "--keep-binary":
        flags.keepBinary = true;
        break;
      case "--keep-path":
        flags.keepPath = true;
        break;
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      default:
        return { ok: false, error: `unknown option: ${arg}` };
    }
  }
  if (flags.keepData && flags.keepBinary) {
    return {
      ok: false,
      error: "--keep-data and --keep-binary together would remove nothing",
    };
  }
  return { ok: true, flags };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * `atomic-agent uninstall` — the one command that undoes the install,
 * so nobody has to reconstruct an `rm -rf` from the README and get the
 * paths wrong in either direction.
 *
 * The warnings are deliberately stacked and deliberately unpleasant:
 * the plan with real sizes, then the sentence saying it is permanent,
 * then a word to type. Each one is cheap for someone who means it and
 * expensive for someone who does not.
 */
export async function uninstallCommand(
  args: string[],
  deps: UninstallCommandDeps = {},
): Promise<number> {
  const resolvePlan = deps.resolvePlan ?? resolveUninstallPlan;
  const run = deps.run ?? runUninstall;
  const getStateDir = deps.getStateDir ?? (() => getConfig().paths.stateDir);
  const isTTY =
    deps.isTTY ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const ask = deps.ask ?? defaultAsk;
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  const writeErr =
    deps.writeErr ?? ((text: string) => void process.stderr.write(text));

  const parsed = parseArgs(args);
  if (!parsed.ok) {
    writeErr(`${parsed.error}\n`);
    return 2;
  }
  if (parsed.flags.help) {
    write(HELP);
    return 0;
  }
  const flags = parsed.flags;

  let plan: ResolvedUninstallPlan;
  try {
    plan = await resolvePlan({
      stateDir: getStateDir(),
      keepData: flags.keepData,
      keepBinary: flags.keepBinary,
    });
  } catch (err) {
    writeErr(`uninstall failed: ${message(err)}\n`);
    return 1;
  }

  write(renderPlan(plan, flags));

  if (plan.measured.targets.length === 0) {
    write("nothing to remove — atomic-agent is not installed here\n");
    return 0;
  }
  if (flags.dryRun) {
    write("dry run: nothing was removed\n");
    return 0;
  }

  if (!flags.yes) {
    if (!isTTY()) {
      writeErr(
        "uninstall needs a terminal to confirm; pass --yes to run unattended\n",
      );
      return 2;
    }
    const answer = await ask(`type ${CONFIRM_WORD} to confirm: `);
    if (answer.trim().toLowerCase() !== CONFIRM_WORD) {
      write("cancelled — nothing was removed\n");
      return 0;
    }
  }

  const result = await run({
    targets: plan.targets,
    keepPathEntry: flags.keepPath,
    onProgress: (line) => write(`  ${line}\n`),
  });

  for (const rc of result.rcFilesEdited) {
    write(`edited ${rc} — open a new shell for PATH to catch up\n`);
  }
  const failures = result.removed.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      writeErr(`could not remove ${failure.path}: ${failure.error}\n`);
    }
    writeErr(
      `${failures.length} of ${result.removed.length} targets could not be removed — ` +
        "remove them by hand to finish\n",
    );
    return 1;
  }
  write("atomic-agent is uninstalled. Thanks for trying it.\n");
  return 0;
}

/** The plan, with sizes, as the operator sees it before deciding. */
function renderPlan(plan: ResolvedUninstallPlan, flags: UninstallFlags): string {
  const lines: string[] = ["", "atomic-agent uninstall will remove:", ""];
  for (const target of plan.measured.targets) {
    lines.push(
      `  ${target.path}  (${formatBytes(target.bytes)})`,
      `      ${target.label}`,
    );
  }
  if (plan.measured.targets.length > 0) {
    lines.push("", `  total: ${formatBytes(plan.measured.totalBytes)}`);
  }
  if (plan.devCheckout) {
    lines.push(
      "",
      "no installed binary found — this looks like a dev checkout, so only data",
      `is listed. The program itself is removed with git. (looked in ${plan.installDir})`,
    );
  }
  if (!flags.keepPath) {
    lines.push(
      "",
      "the PATH line install.sh added to your shell rc file will also be removed.",
    );
  }
  if (!flags.keepData) {
    lines.push(
      "",
      "THIS CANNOT BE UNDONE. There is no backup and no undo: your memory fabric,",
      "your session history and any downloaded model weights go with it.",
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
