import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../config/index.js";
import { SessionStore } from "../session/index.js";
import { TaskStore } from "../tasks/index.js";
import {
  HermesImporter,
  HermesSource,
  ImportOptionError,
  resolveSelectedOptions,
  OpenclawImporter,
  OpenclawSource,
  OpenclawOptionError,
  OPENCLAW_DEFAULT_AGENT,
  resolveOpenclawOptions,
  type ImportOptionId,
  type OpenclawOptionId,
  type ImportReport,
} from "../import/index.js";

const HELP =
  [
    "atomic-agent import — one-shot import from another agent's state",
    "",
    "Subcommands:",
    "  hermes [options]          Import conversation history + cron jobs from ~/.hermes",
    "  openclaw [options]        Import conversation history + cron jobs from ~/.openclaw",
    "",
    "Options (import hermes):",
    "  --source <dir>            Hermes state dir (default ~/.hermes, env HERMES_STATE_DIR)",
    "  --preset default|full     Option preset (default: default = sessions + cron)",
    "  --include a,b             Add options (sessions,cron)",
    "  --exclude a,b             Remove options",
    "  --migrate-secrets         Also copy OPENROUTER_API_KEY / AIMLAPI_API_KEY into <stateDir>/.env",
    "  --limit N                 Cap the number of sessions imported",
    "  --overwrite               Overwrite destinations that differ (default: flag as conflict)",
    "  --dry-run                 Preview only; never write",
    "  --yes                     Skip the interactive confirmation",
    "",
    "Options (import openclaw):",
    "  --source <dir>            OpenClaw state dir (default ~/.openclaw, env OPENCLAW_STATE_DIR)",
    "  --agent <name>            OpenClaw agent whose sessions to import (default main)",
    "  --include a,b             Add options (sessions,cron)",
    "  --exclude a,b             Remove options",
    "  --limit N                 Cap the number of sessions imported",
    "  --overwrite               Overwrite destinations that differ (default: flag as conflict)",
    "  --dry-run                 Preview only; never write",
    "  --yes                     Skip the interactive confirmation",
    "",
    "Examples:",
    "  atomic-agent import hermes --dry-run",
    "  atomic-agent import hermes --yes",
    "  atomic-agent import hermes --migrate-secrets --overwrite",
    "  atomic-agent import openclaw --dry-run",
    "  atomic-agent import openclaw --agent main --yes",
  ].join("\n") + "\n";

export async function importCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  if (sub === "hermes") {
    return importHermes(args.slice(1));
  }
  if (sub === "openclaw") {
    return importOpenclaw(args.slice(1));
  }
  process.stderr.write(`unknown import source: ${sub}\n`);
  process.stderr.write(HELP);
  return 1;
}

async function importHermes(args: string[]): Promise<number> {
  const sourceDir =
    readOption(args, "--source") ??
    process.env.HERMES_STATE_DIR ??
    join(homedir(), ".hermes");
  const preset = readOption(args, "--preset");
  const include = parseCsv(readOption(args, "--include"));
  const exclude = parseCsv(readOption(args, "--exclude"));
  const migrateSecrets = args.includes("--migrate-secrets");
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

  let options: ImportOptionId[];
  try {
    options = resolveSelectedOptions({
      ...(preset ? { preset: preset as never } : {}),
      include,
      exclude,
      migrateSecrets,
    });
  } catch (err) {
    if (err instanceof ImportOptionError) {
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
  const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const source = new HermesSource(sourceDir);

  try {
    const importer = new HermesImporter({
      source,
      sessionStore,
      taskStore,
      stateDir: config.paths.stateDir,
      maxAttempts: config.tasks.maxAttempts,
      workingDirFallback: process.cwd(),
    });

    process.stdout.write(`Source: ${sourceDir}\n`);
    process.stdout.write(`Selected: ${options.join(", ")}\n\n`);

    // Phase 1: preview.
    const preview = importer.run({ options, execute: false, overwrite, limit });
    process.stdout.write("Preview:\n");
    process.stdout.write(`${formatReport(preview)}\n`);

    if (dryRun) {
      process.stdout.write("\nDry-run: nothing was written.\n");
      return 0;
    }

    const actionable =
      preview.summary.migrated + preview.summary.conflict > 0;
    if (!actionable) {
      process.stdout.write("\nNothing to import.\n");
      return 0;
    }

    if (!yes) {
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
    const final = importer.run({ options, execute: true, overwrite, limit });
    process.stdout.write("\nResult:\n");
    process.stdout.write(`${formatReport(final)}\n`);
    return final.summary.error > 0 ? 1 : 0;
  } finally {
    source.close();
    sessionStore.close();
    taskStore.close();
  }
}

async function importOpenclaw(args: string[]): Promise<number> {
  const sourceDir =
    readOption(args, "--source") ??
    process.env.OPENCLAW_STATE_DIR ??
    join(homedir(), ".openclaw");
  const agent = readOption(args, "--agent") ?? OPENCLAW_DEFAULT_AGENT;
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

  let options: OpenclawOptionId[];
  try {
    options = resolveOpenclawOptions({ include, exclude });
  } catch (err) {
    if (err instanceof OpenclawOptionError) {
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
  const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const source = new OpenclawSource(sourceDir, agent);

  try {
    const importer = new OpenclawImporter({
      source,
      sessionStore,
      taskStore,
      maxAttempts: config.tasks.maxAttempts,
      workingDirFallback: process.cwd(),
    });

    process.stdout.write(`Source: ${sourceDir} (agent: ${agent})\n`);
    process.stdout.write(`Selected: ${options.join(", ")}\n\n`);

    // Phase 1: preview.
    const preview = importer.run({ options, execute: false, overwrite, limit });
    process.stdout.write("Preview:\n");
    process.stdout.write(`${formatReport(preview)}\n`);

    if (dryRun) {
      process.stdout.write("\nDry-run: nothing was written.\n");
      return 0;
    }

    const actionable =
      preview.summary.migrated + preview.summary.conflict > 0;
    if (!actionable) {
      process.stdout.write("\nNothing to import.\n");
      return 0;
    }

    if (!yes) {
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
    const final = importer.run({ options, execute: true, overwrite, limit });
    process.stdout.write("\nResult:\n");
    process.stdout.write(`${formatReport(final)}\n`);
    return final.summary.error > 0 ? 1 : 0;
  } finally {
    source.close();
    sessionStore.close();
    taskStore.close();
  }
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
