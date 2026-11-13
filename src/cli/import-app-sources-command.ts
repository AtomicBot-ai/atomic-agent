import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  AtomicAgentImporter,
  AtomicAgentOptionError,
  ClaudeAppImporter,
  ClaudeAppOptionError,
  ClaudeAppSource,
  groupImportReport,
  resolveAtomicAgentOptions,
  resolveClaudeAppOptions,
  type AtomicAgentOptionId,
  type ClaudeAppOptionId,
} from "../import/index.js";
import { MemoryStore, ProfileStore } from "../memory/index.js";
import { SessionStore } from "../session/index.js";
import { TaskStore } from "../tasks/index.js";
import { parseCsv, readOption, runTwoPhase } from "./import-pi-family-command.js";

/**
 * `atomic-agent import claude-app` and `atomic-agent import atomic-agent`:
 * the two sources that are not another coding agent's state dir. Kept out
 * of import-command.ts, which is past the layout cap; the dispatcher and
 * the shared HELP stay there.
 */
export async function importClaudeApp(args: string[]): Promise<number> {
  const sourceArg = readOption(args, "--source");
  if (!sourceArg) {
    process.stderr.write(
      "--source <file.zip|dir> is required: the Claude data export (Claude › Settings › Privacy › Export data)\n",
    );
    return 1;
  }
  const sourcePath = resolve(sourceArg);
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const limit = parseLimit(readOption(args, "--limit"));
  if (limit === null) return 1;
  let options: ClaudeAppOptionId[];
  try {
    options = resolveClaudeAppOptions({
      include: parseCsv(readOption(args, "--include")),
      exclude: parseCsv(readOption(args, "--exclude")),
    });
  } catch (err) {
    if (err instanceof ClaudeAppOptionError) {
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
  const sessionStore = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  const memoryStore = new MemoryStore({
    dbFile: config.paths.memoryDbFile,
    maxEntries: config.memory.notes.maxEntries,
  });
  try {
    const importer = new ClaudeAppImporter({
      source: new ClaudeAppSource(sourcePath),
      sessionStore,
      memoryStore,
      workingDir: process.cwd(),
    });
    return await runTwoPhase({
      sourceLine: `Source: ${sourcePath}\n`,
      selectedLine: `Selected: ${options.join(", ")}\n\n`,
      dryRun,
      yes,
      run: async (execute) =>
        groupImportReport(
          await importer.run({ options, execute, overwrite, ...(limit !== undefined ? { limit } : {}) }),
          { stateDir: config.paths.stateDir, execute },
        ),
    });
  } finally {
    sessionStore.close();
    memoryStore.close();
  }
}

export async function importAtomicAgent(args: string[]): Promise<number> {
  const sourceDir = resolve(
    readOption(args, "--source") ?? join(homedir(), ".atomic-agent"),
  );
  const overwrite = args.includes("--overwrite");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  let options: AtomicAgentOptionId[];
  try {
    options = resolveAtomicAgentOptions({
      include: parseCsv(readOption(args, "--include")),
      exclude: parseCsv(readOption(args, "--exclude")),
      migrateSecrets: args.includes("--migrate-secrets"),
    });
  } catch (err) {
    if (err instanceof AtomicAgentOptionError) {
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
  const opened: Array<{ close(): void }> = [];
  try {
    const sessionStore = new SessionStore({ dbFile: config.paths.sessionsDbFile });
    opened.push(sessionStore);
    const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
    opened.push(taskStore);
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
    const importer = new AtomicAgentImporter({
      sourceDir,
      stateDir: config.paths.stateDir,
      userConfigFile: config.paths.userConfigFile,
      globalSkillsDir: config.paths.globalSkillsDir,
      targets: { sessionStore, taskStore, memoryStore, profileStore },
    });
    return await runTwoPhase({
      sourceLine: `Source: ${sourceDir}\n`,
      selectedLine: `Selected: ${options.join(", ")}\n\n`,
      dryRun,
      yes,
      run: (execute) => importer.run({ options, execute, overwrite }),
    });
  } finally {
    for (const store of opened.reverse()) {
      try {
        store.close();
      } catch {
        // best effort
      }
    }
  }
}

/** `undefined` for no limit, `null` (after printing why) for a bad one. */
function parseLimit(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(raw)) {
    process.stderr.write("--limit must be a non-negative integer\n");
    return null;
  }
  return n;
}
