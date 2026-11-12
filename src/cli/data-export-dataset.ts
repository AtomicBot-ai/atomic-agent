import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { knownSecretsFromEnv, type KnownSecret } from "../error-reporting/index.js";
import {
  createDatasetScrubber,
  exportDataset,
  SessionStore,
  totalRedactions,
  type ExportDatasetResult,
} from "../session/index.js";

/**
 * ATO-1104 — `atag data export-dataset --out <file.jsonl>`: your own chats
 * as a chat fine-tuning file, for training a personal model. Opt-in by
 * construction: nothing runs it but this command. What you typed and the
 * agent's final answers go in (tool calls and tool output never do), keys,
 * tokens, emails and home folder paths are replaced, and the file stays
 * on this machine. See `src/session/dataset-export/`.
 */
export const EXPORT_DATASET_HELP = [
  "Usage: atomic-agent data export-dataset --out <file.jsonl> [--sessions <n>] [--since <date>]",
  "",
  "Writes your chats as a fine-tuning file: one line per chat, {\"messages\":[{role, content}, ...]}.",
  "Only your messages and the agent's final answers go in; tool calls and tool output are left out.",
  "API keys, tokens, passwords, emails and home folder paths are replaced before anything is written.",
  "Nothing is uploaded: the file is written on this machine and stays there.",
  "",
  "  --out <file.jsonl>  Where to write it (must not exist yet)",
  "  --sessions <n>      Only the n most recent chats",
  "  --since <date>      Only chats active on or after this date, e.g. 2026-10-01",
].join("\n");

export interface ExportDatasetCommandDeps {
  /** The real data folder (symlinks resolved). */
  stateDir: string;
  write: (text: string) => void;
  homeDir?: string;
  known?: readonly KnownSecret[];
}

interface ParsedArgs {
  out: string;
  maxSessions?: number;
  sinceMs?: number;
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function parseArgs(args: readonly string[]): ParsedArgs | string {
  const out = valueOf(args, "--out");
  if (!out || out.startsWith("-")) return "data export-dataset needs --out <file.jsonl>";
  const parsed: ParsedArgs = { out: resolve(out) };
  const sessions = valueOf(args, "--sessions");
  if (sessions !== undefined) {
    const n = Number(sessions);
    if (!Number.isInteger(n) || n < 1) return `--sessions takes a whole number of chats, got ${sessions}`;
    parsed.maxSessions = n;
  }
  const since = valueOf(args, "--since");
  if (since !== undefined) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) return `--since takes a date such as 2026-10-01, got ${since}`;
    parsed.sinceMs = ms;
  }
  return parsed;
}

export function exportDatasetCommand(args: readonly string[], deps: ExportDatasetCommandDeps): number {
  const { write } = deps;
  if (args.includes("-h") || args.includes("--help")) {
    write(`${EXPORT_DATASET_HELP}\n`);
    return 0;
  }
  const parsed = parseArgs(args);
  if (typeof parsed === "string") {
    write(`${parsed}\n\n${EXPORT_DATASET_HELP}\n`);
    return 2;
  }
  if (existsSync(parsed.out)) {
    write(`${parsed.out} already exists; pick a new file name\n`);
    return 2;
  }
  const dbFile = join(deps.stateDir, "sessions.sqlite");
  if (!existsSync(dbFile)) {
    write("no chats to export yet\n");
    return 1;
  }

  const scrubber = createDatasetScrubber({
    homeDir: deps.homeDir ?? homedir(),
    known: deps.known ?? knownSecretsFromEnv(),
  });
  const store = new SessionStore({ dbFile });
  let result: ExportDatasetResult;
  try {
    result = exportDataset({
      store,
      outFile: parsed.out,
      scrubber,
      ...(parsed.maxSessions !== undefined ? { maxSessions: parsed.maxSessions } : {}),
      ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
    });
  } catch (err) {
    write(`export failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    store.close();
  }

  const c = scrubber.counts;
  write(`exported ${result.records} chats (${result.messages} messages) to ${parsed.out}\n`);
  if (result.sessionsSkipped > 0) {
    write(`skipped ${result.sessionsSkipped} chats with no answered message\n`);
  }
  write(
    `replaced ${totalRedactions(c)} items: ${c.secrets} keys or tokens, ${c.emails} emails, ${c.homePaths} home folder paths\n`,
  );
  write("nothing was uploaded. The scrubbing is pattern-based: read the file before you share it.\n");
  return 0;
}
