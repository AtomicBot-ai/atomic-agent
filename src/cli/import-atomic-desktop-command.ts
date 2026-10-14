import { resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  ATOMIC_DESKTOP_NOT_IMPORTED,
  checkAtomicDesktopSource,
  importAtomicDesktop,
  type AtomicDesktopImportResult,
} from "../import/index.js";
import { MemoryStore, ProfileStore } from "../memory/index.js";
import { SessionStore } from "../session/index.js";
import { TaskStore } from "../tasks/index.js";

export const IMPORT_ATOMIC_DESKTOP_HELP =
  [
    "atomic-agent import atomic-desktop — merge an old desktop state dir into this one",
    "",
    "Usage:",
    "  atomic-agent import atomic-desktop --source <dir> [--json]",
    "",
    "Merges the databases of the Atomic Agent desktop app's former state dir",
    "(~/.atomic-agent-desktop) into the current one (ATOMIC_AGENT_STATE_DIR,",
    "default ~/.atomic-agent). Safe to re-run: a second run imports nothing new.",
    "The source is only read, through a snapshot; it is never written or removed.",
    "",
    "  sessions        copied by id; an id already here is kept as it is",
    "  tasks           copied by id (history included); a running task arrives pending",
    "  memory notes    added unless the same text is already stored",
    "  profile facts   added unless this state dir has the key (its value wins)",
    `  not imported    ${ATOMIC_DESKTOP_NOT_IMPORTED.join(", ")} (rebuilt here)`,
    "",
    "Files (config.json, .env, skills, traces, models) are not touched here.",
    "",
    "Options:",
    "  --source <dir>  The old desktop state dir (required)",
    "  --json          Print one JSON object instead of the summary:",
    "                  {ok, sessions:{imported,skipped}, tasks:{...}, notes:{...},",
    "                   profileFacts:{...}, warnings:[], error?}",
  ].join("\n") + "\n";

/**
 * `atomic-agent import atomic-desktop`: the database half of moving the
 * desktop app onto the shared state dir (ATO-416). Non-interactive on
 * purpose — the desktop runs it once at startup — and safe beside a TUI
 * or `serve` holding the target databases open: every write is a short
 * transaction that waits on their locks.
 *
 * Exit 0 when every part imported, 1 otherwise (bad arguments, an
 * unusable source, or a part that failed; the parts that did not fail
 * are still imported).
 */
export async function importAtomicDesktopCommand(
  args: string[],
): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(IMPORT_ATOMIC_DESKTOP_HELP);
    return 0;
  }
  const json = args.includes("--json");
  const sourceArg = readOption(args, "--source");
  if (sourceArg === undefined) {
    return fail(json, "--source <dir> is required (the old desktop state dir)");
  }
  const sourceDir = resolve(sourceArg);

  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch (err) {
    return fail(json, `cannot load the target config: ${errorMessage(err)}`);
  }
  const targetStateDir = config.paths.stateDir;
  // Before any target store opens: a refused source creates nothing.
  const problem = checkAtomicDesktopSource(sourceDir, targetStateDir);
  if (problem !== null) return fail(json, problem);

  const opened: Array<{ close(): void }> = [];
  let result: AtomicDesktopImportResult;
  try {
    const sessionStore = new SessionStore({
      dbFile: config.paths.sessionsDbFile,
    });
    opened.push(sessionStore);
    const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
    opened.push(taskStore);
    // Dedup off, as for every importer: exact-content skip is the
    // importer's own, and a near-match merge would rewrite what is copied.
    // The configured caps and eviction stay, as the runtime would apply.
    const memoryStore = new MemoryStore({
      dbFile: config.paths.memoryDbFile,
      maxEntries: config.memory.notes.maxEntries,
      eviction: {
        utilityWeighted: config.memory.eviction.utilityWeighted,
        maxAgeMs: config.memory.eviction.maxAgeMs,
      },
    });
    opened.push(memoryStore);
    const profileStore = new ProfileStore({
      dbFile: config.paths.memoryDbFile,
      maxEntries: config.memory.profile.maxEntries,
    });
    opened.push(profileStore);
    result = await importAtomicDesktop({
      sourceDir,
      targetStateDir,
      targets: { sessionStore, taskStore, memoryStore, profileStore },
    });
  } catch (err) {
    return fail(json, `import failed: ${errorMessage(err)}`);
  } finally {
    for (const store of opened.reverse()) {
      try {
        store.close();
      } catch {
        // Closing is best effort; the import itself is what reports.
      }
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(toJson(result))}\n`);
  } else {
    process.stdout.write(formatSummary(result, sourceDir, targetStateDir));
    for (const error of result.errors) {
      process.stderr.write(`error: ${error}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

/** The `--json` object: the counts, `warnings`, and `error` only on failure. */
function toJson(result: AtomicDesktopImportResult): Record<string, unknown> {
  return {
    ok: result.ok,
    sessions: result.sessions,
    tasks: result.tasks,
    notes: result.notes,
    profileFacts: result.profileFacts,
    warnings: result.warnings,
    ...(result.ok ? {} : { error: result.errors.join("; ") }),
  };
}

function formatSummary(
  result: AtomicDesktopImportResult,
  sourceDir: string,
  targetStateDir: string,
): string {
  const row = (label: string, c: { imported: number; skipped: number }) =>
    `  ${label.padEnd(14)} ${String(c.imported).padStart(6)} imported, ${c.skipped} skipped`;
  const lines = [
    `Merged ${sourceDir} into ${targetStateDir}:`,
    row("sessions", result.sessions),
    row("tasks", result.tasks),
    row("memory notes", result.notes),
    row("profile facts", result.profileFacts),
    `  not imported: ${ATOMIC_DESKTOP_NOT_IMPORTED.join(", ")}`,
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ];
  return `${lines.join("\n")}\n`;
}

function fail(json: boolean, message: string): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        sessions: { imported: 0, skipped: 0 },
        tasks: { imported: 0, skipped: 0 },
        notes: { imported: 0, skipped: 0 },
        profileFacts: { imported: 0, skipped: 0 },
        warnings: [],
        error: message,
      })}\n`,
    );
  }
  process.stderr.write(`${message}\n`);
  return 1;
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
