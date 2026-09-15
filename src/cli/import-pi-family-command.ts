import { createInterface } from "node:readline/promises";

import { getConfig } from "../config/index.js";
import { SessionStore } from "../session/index.js";
import {
  importAgentDir,
  OhMyPiImporter,
  OhMyPiOptionError,
  OhMyPiSource,
  PiImporter,
  PiOptionError,
  PiSource,
  resolveOhMyPiOptions,
  resolvePiOptions,
  type ImportReport,
  type OhMyPiOptionId,
  type PiOptionId,
} from "../import/index.js";

/**
 * The Pi-family subcommands of `atomic-agent import` — Pi and its hard
 * fork Oh-My-Pi. They live outside `import-command.ts` because that
 * file is already past the layout cap; the dispatcher and shared HELP
 * stay there. The small console helpers at the bottom are duplicated
 * from it so the two command files stay acyclic.
 */
export async function importPi(args: string[]): Promise<number> {
  const sourceDir = readOption(args, "--source") ?? importAgentDir("pi");
  const include = parseCsv(readOption(args, "--include"));
  const exclude = parseCsv(readOption(args, "--exclude"));
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const limitRaw = readOption(args, "--limit");

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit < 0) {
      process.stderr.write("--limit must be a non-negative integer\n");
      return 1;
    }
  }

  let options: PiOptionId[];
  try {
    options = resolvePiOptions({ include, exclude });
  } catch (err) {
    if (err instanceof PiOptionError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (options.length === 0) {
    process.stderr.write("nothing selected to import\n");
    return 1;
  }

  const config = getConfig();
  const sessionStore = new SessionStore({
    dbFile: config.paths.sessionsDbFile,
  });

  try {
    const importer = new PiImporter({
      source: new PiSource(sourceDir),
      sessionStore,
      globalSkillsDir: config.paths.globalSkillsDir,
      workingDirFallback: process.cwd(),
    });
    return await runTwoPhase({
      sourceLine: `Source: ${sourceDir}\n`,
      selectedLine: `Selected: ${options.join(", ")}\n\n`,
      dryRun,
      yes,
      run: (execute) => importer.run({ options, execute, overwrite, limit }),
    });
  } finally {
    sessionStore.close();
  }
}

export async function importOhMyPi(args: string[]): Promise<number> {
  const sourceDir = readOption(args, "--source") ?? importAgentDir("oh-my-pi");
  const include = parseCsv(readOption(args, "--include"));
  const exclude = parseCsv(readOption(args, "--exclude"));
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const limitRaw = readOption(args, "--limit");

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit < 0) {
      process.stderr.write("--limit must be a non-negative integer\n");
      return 1;
    }
  }

  let options: OhMyPiOptionId[];
  try {
    options = resolveOhMyPiOptions({ include, exclude });
  } catch (err) {
    if (err instanceof OhMyPiOptionError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (options.length === 0) {
    process.stderr.write("nothing selected to import\n");
    return 1;
  }

  const config = getConfig();
  const sessionStore = new SessionStore({
    dbFile: config.paths.sessionsDbFile,
  });

  try {
    const importer = new OhMyPiImporter({
      source: new OhMyPiSource(sourceDir),
      sessionStore,
      userConfigFile: config.paths.userConfigFile,
      globalSkillsDir: config.paths.globalSkillsDir,
      workingDirFallback: process.cwd(),
    });
    return await runTwoPhase({
      sourceLine: `Source: ${sourceDir}\n`,
      selectedLine: `Selected: ${options.join(", ")}\n\n`,
      dryRun,
      yes,
      run: (execute) => importer.run({ options, execute, overwrite, limit }),
    });
  } finally {
    sessionStore.close();
  }
}

/**
 * The preview -> confirm -> execute skeleton every import subcommand
 * follows, with the phases behind one `run(execute)` callback.
 */
async function runTwoPhase(input: {
  sourceLine: string;
  selectedLine: string;
  dryRun: boolean;
  yes: boolean;
  run(execute: boolean): Promise<ImportReport>;
}): Promise<number> {
  process.stdout.write(input.sourceLine);
  process.stdout.write(input.selectedLine);

  // Phase 1: preview.
  const preview = await input.run(false);
  process.stdout.write("Preview:\n");
  process.stdout.write(`${formatReport(preview)}\n`);

  if (input.dryRun) {
    process.stdout.write("\nDry-run: nothing was written.\n");
    return 0;
  }

  const actionable = preview.summary.migrated + preview.summary.conflict > 0;
  if (!actionable) {
    process.stdout.write("\nNothing to import.\n");
    return 0;
  }

  if (!input.yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write(
        "\nNon-interactive: re-run with --yes to apply, or --dry-run to preview only.\n",
      );
      return 0;
    }
    const confirmed = await confirm("\nApply this import? [y/N] ");
    if (!confirmed) {
      process.stdout.write("Aborted.\n");
      return 0;
    }
  }

  // Phase 2: execute.
  const final = await input.run(true);
  process.stdout.write("\nResult:\n");
  process.stdout.write(`${formatReport(final)}\n`);
  return final.summary.error > 0 ? 1 : 0;
}

function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  for (const item of report.items) {
    const arrow =
      item.source && item.destination
        ? `${item.source} -> ${item.destination}`
        : (item.source ?? item.destination ?? "");
    const reason = item.reason ? ` (${item.reason})` : "";
    lines.push(`  [${item.kind}] ${item.status.padEnd(8)} ${arrow}${reason}`);
  }
  const s = report.summary;
  lines.push(
    `  ----\n  migrated=${s.migrated} skipped=${s.skipped} conflict=${s.conflict} error=${s.error}`,
  );
  return lines.join("\n");
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
