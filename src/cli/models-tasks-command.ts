/**
 * `models tasks collect [--last <n>] [--out <file>] [--json]` (ATO-1089).
 *
 * Reads the user's recent chats and writes their last N tasks as a
 * fit-test set (`src/fit-test/`). Tasks that sent something outside the
 * machine are left out; secrets are masked. Without `--out` the set goes
 * to stdout. The command only reads the sessions database.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../config/index.js";
import { knownSecretsFromEnv } from "../error-reporting/secret-detector.js";
import { collectUserTasks, type CollectSkips } from "../fit-test/index.js";
import { SessionStore } from "../session/index.js";
import { readCliOption } from "./models-handlers.js";

const DEFAULT_LAST = 10;
/** Sessions read to find the tasks: enough for 10 tasks in short chats. */
const SESSIONS_SCANNED = 50;

const USAGE =
  "usage: atomic-agent models tasks collect [--last <n>] [--out <file>] [--json]\n";

export function parseLastFlag(args: string[]): number | "invalid" {
  const raw = readCliOption(args, "--last");
  if (raw === undefined) return DEFAULT_LAST;
  if (!/^[1-9]\d{0,3}$/.test(raw)) return "invalid";
  return Number(raw);
}

function skipLine(skipped: CollectSkips): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([why, n]) => `${n} ${why}`);
  return parts.length > 0 ? ` (left out: ${parts.join(", ")})` : "";
}

export async function runModelsTasks(args: string[]): Promise<number> {
  if (args[0] !== "collect") {
    process.stderr.write(USAGE);
    return args[0] === undefined || args[0] === "--help" ? 0 : 2;
  }
  const rest = args.slice(1);
  const last = parseLastFlag(rest);
  if (last === "invalid") {
    process.stderr.write("--last needs a whole number from 1 to 9999\n");
    return 2;
  }
  const out = readCliOption(rest, "--out");
  if (rest.includes("--out") && !out) {
    process.stderr.write("--out needs a file path\n");
    return 2;
  }
  const config = getConfig();
  const store = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  let result;
  try {
    result = collectUserTasks(store.listRecent(SESSIONS_SCANNED), {
      last,
      knownSecrets: knownSecretsFromEnv(),
    });
  } finally {
    store.close();
  }
  const body = `${JSON.stringify(result.set, null, 2)}\n`;
  if (out === undefined) {
    process.stdout.write(body);
    process.stderr.write(`collected ${result.set.tasks.length} task(s)${skipLine(result.skipped)}\n`);
  } else {
    const path = resolve(out);
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, path, tasks: result.set.tasks.length, skipped: result.skipped })}\n`);
    } else {
      process.stdout.write(`wrote ${result.set.tasks.length} task(s) to ${path}${skipLine(result.skipped)}\n`);
    }
  }
  return 0;
}
