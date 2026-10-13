import { getConfig } from "../config/index.js";
import {
  DEFAULT_EXPORT_FOLDER,
  EmbeddingStore,
  EmbeddingWriter,
  MemoryStore,
  ObsidianExportUsageError,
  exportMemoryToObsidian,
} from "../memory/index.js";
import {
  backfillEmbeddings,
  type EmbeddingBackfillResult,
} from "../memory/embeddings/index.js";
import {
  connectMemoryEmbeddings,
  type MemoryEmbeddingConnection,
} from "../memory/embeddings/memory-embedding-connection.js";

const HELP =
  [
    "atomic-agent memory — inspect, export + reindex the cross-session memory store",
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
    "  reindex [--prune] [--json]",
    "                            Embed every note that has no vector for the",
    "                            current embedding model (after switching models,",
    "                            or turning embeddings on over existing notes),",
    "                            newest first. The running agent does the same",
    "                            in the background unless",
    "                            memory.embeddings.backfill is false; this runs it",
    "                            now. Needs the embedding model running",
    "                            (atomic-agent models start-embedding). Safe to",
    "                            stop and rerun: it resumes where it stopped.",
    "                            --prune then deletes the vectors of every other",
    "                            model, once every note has one for the current",
    "                            model. --json prints the result as JSON.",
    "",
    "Examples:",
    "  atomic-agent memory export --vault ~/Documents/MyVault",
    "  OBSIDIAN_VAULT_PATH=~/Documents/MyVault atomic-agent memory export",
    "  atomic-agent memory reindex",
    "  atomic-agent memory reindex --prune",
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
    case "reindex":
      return handleReindex(args.slice(1));
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
  const vaultDir =
    readOption(args, "--vault") ?? process.env.OBSIDIAN_VAULT_PATH;
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

const REINDEX_USAGE = "usage: atomic-agent memory reindex [--prune] [--json]\n";
const START_EMBEDDING_HINT = "start it with: atomic-agent models start-embedding";

/** Seams for tests; production uses the configured model and the real backfill. */
export interface ReindexDeps {
  connect?: typeof connectMemoryEmbeddings;
  backfill?: typeof backfillEmbeddings;
  /** Aborts the run (Ctrl-C). Default: SIGINT. */
  onInterrupt?: (abort: () => void) => () => void;
}

/**
 * `memory reindex`: the runtime's background backfill, in the foreground.
 * Exit 0 when every note has a vector for the current model, 1 when the
 * model is off or stopped answering (what is done stays done), 130 when
 * interrupted, 2 on usage errors.
 */
export async function handleReindex(args: string[], deps: ReindexDeps = {}): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const unknown = args.find((a) => a !== "--prune" && a !== "--json");
  if (unknown !== undefined) {
    process.stderr.write(`unknown option: ${unknown}\n${REINDEX_USAGE}`);
    return 2;
  }
  const json = args.includes("--json");
  const prune = args.includes("--prune");
  const config = getConfig();
  const connection: MemoryEmbeddingConnection = await (deps.connect ?? connectMemoryEmbeddings)(config);
  if (connection.state === "disabled") {
    return reindexFailed(json, "disabled",
      "memory embeddings are off: pick a model with 'atomic-agent models use-embedding <id>' " +
        "and set memory.embeddings.enabled to true");
  }
  if (connection.state === "unreachable") {
    return reindexFailed(json, "unavailable", `${connection.why}; ${START_EMBEDDING_HINT}`);
  }

  const notes = new MemoryStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.notes.maxEntries,
  });
  const controller = new AbortController();
  const release = (deps.onInterrupt ?? onSigint)(() => controller.abort());
  try {
    const client = connection.createClient();
    const db = notes.getDatabaseHandleForEmbeddings();
    const embeddings = new EmbeddingStore({ db });
    const writer = new EmbeddingWriter({ client, store: embeddings });
    // A progress line only on a terminal: a pipe (the desktop app, --json)
    // gets the result alone.
    const live = !json && process.stderr.isTTY === true;
    const result: EmbeddingBackfillResult = await (deps.backfill ?? backfillEmbeddings)(
      { db, writer },
      {
        signal: controller.signal,
        onProgress: live
          ? (p) => process.stderr.write(`\rreindexing ${client.model}: ${p.embedded + p.skipped}/${p.total}`)
          : undefined,
      },
    );
    if (live) process.stderr.write("\n");

    // Old vectors go only once the new model covers every note: pruning
    // earlier would leave the rest without any vector at all.
    const pruned: Array<{ model: string; deleted: number }> = [];
    const complete = result.stoppedReason === undefined && result.remaining === 0;
    if (prune && complete) {
      for (const { model } of embeddings.countPerModel()) {
        if (model !== client.model) pruned.push({ model, deleted: embeddings.deleteAllForModel(model) });
      }
    }
    if (json) {
      process.stdout.write(`${JSON.stringify({ ...result, ...(prune ? { pruned } : {}) })}\n`);
    } else {
      process.stdout.write(
        `embedded ${result.embedded} notes with ${result.model}` +
          (result.skipped > 0 ? `, skipped ${result.skipped}` : "") +
          `; ${result.remaining} left without a vector\n`,
      );
      for (const p of pruned) process.stdout.write(`pruned ${p.deleted} vectors of ${p.model}\n`);
      if (prune && !complete) process.stdout.write("nothing pruned: some notes still have no vector for the current model\n");
    }
    switch (result.stoppedReason) {
      case undefined:
        return 0;
      case "aborted":
        if (!json) process.stderr.write("reindex interrupted; run it again to continue\n");
        return 130;
      case "unavailable":
        if (!json) process.stderr.write(`the embedding model stopped answering; ${START_EMBEDDING_HINT}, then run this again\n`);
        return 1;
      case "failed":
        if (!json) process.stderr.write("reindex stopped on an error writing a vector; run it again to retry\n");
        return 1;
    }
  } catch (err) {
    process.stderr.write(`memory reindex failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    release();
    notes.close();
  }
}

function reindexFailed(json: boolean, reason: "disabled" | "unavailable", message: string): number {
  if (json) process.stdout.write(`${JSON.stringify({ stoppedReason: reason, message })}\n`);
  process.stderr.write(`${message}\n`);
  return 1;
}

function onSigint(abort: () => void): () => void {
  process.once("SIGINT", abort);
  return () => process.off("SIGINT", abort);
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}
