import { getConfig } from "../config/index.js";
import {
  DEFAULT_EXPORT_FOLDER,
  ObsidianExportUsageError,
  exportMemoryToObsidian,
} from "../memory/index.js";

const HELP =
  [
    "atomic-agent memory — inspect + export the cross-session memory store",
    "",
    "The corpus (notes / lessons / procedures) lives in <stateDir>/memory.sqlite.",
    "",
    "Subcommands:",
    "  export [--vault <path>] [--folder <name>]",
    "                            One-way export of the corpus into an Obsidian",
    "                            vault as markdown files with YAML frontmatter",
    "                            and [[wikilinks]] along the schema's own edges",
    "                            (memory links, lesson/procedure parents).",
    "                            --vault defaults to $OBSIDIAN_VAULT_PATH and",
    "                            must point at an existing vault directory.",
    `                            --folder is the vault subfolder the export`,
    `                            owns (default '${DEFAULT_EXPORT_FOLDER}'). Idempotent:`,
    "                            re-exports overwrite in place; stale note-<n>.md /",
    "                            lesson-<n>.md / procedure-<n>.md files whose",
    "                            record is gone are pruned; other files are",
    "                            never touched. The database is opened",
    "                            read-only — nothing syncs back.",
    "",
    "Examples:",
    "  atomic-agent memory export --vault ~/Documents/MyVault",
    "  OBSIDIAN_VAULT_PATH=~/Documents/MyVault atomic-agent memory export",
  ].join("\n") + "\n";

export async function memoryCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  switch (sub) {
    case "export":
      return handleExport(args.slice(1));
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

function handleExport(args: string[]): number {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  // `getConfig()` first: it merges `<stateDir>/.env` into `process.env`,
  // so an OBSIDIAN_VAULT_PATH kept there is visible below.
  const config = getConfig();
  const vaultDir = readOption(args, "--vault") ?? process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultDir) {
    process.stderr.write(
      "usage: atomic-agent memory export --vault <path> [--folder <name>] (or set OBSIDIAN_VAULT_PATH)\n",
    );
    return 2;
  }
  const folder = readOption(args, "--folder");
  try {
    const result = exportMemoryToObsidian({
      dbFile: config.paths.memoryDbFile,
      vaultDir,
      ...(folder !== undefined ? { folder } : {}),
    });
    const pruned = result.pruned > 0 ? ` (pruned ${result.pruned} stale)` : "";
    process.stdout.write(
      `exported ${result.notes} notes, ${result.lessons} lessons, ${result.procedures} procedures -> ${result.root}${pruned}\n`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ObsidianExportUsageError) {
      process.stderr.write(`${message}\n`);
      return 2;
    }
    process.stderr.write(`memory export failed: ${message}\n`);
    return 1;
  }
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}
