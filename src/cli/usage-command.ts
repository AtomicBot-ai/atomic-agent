import { join } from "node:path";

import { getConfig, resolveStateDir } from "../config/index.js";
import { spendDayKey } from "../session/daily-spend.js";
import { readUsageHistory, USAGE_HISTORY_FILE_NAME, type UsageHistoryFile } from "../session/usage-history.js";
import { formatUsageHistory, summarizeUsageHistory } from "../session/usage-history-report.js";

/**
 * ATO-2352 — `atag usage`: tokens and cloud cost per day, across every
 * session, from `<stateDir>/usage-history.json`. Read-only. Precedent:
 * `ccusage daily`, Claude Code `/usage`, OpenCode `stats --days`.
 */
const HELP = [
  "Usage: atomic-agent usage [--days N | --all] [--models] [--json]",
  "",
  "Tokens and cost per day, over every session (terminal and desktop app).",
  "  --days N   the last N days, today included (default 7)",
  "  --all      every day on record",
  "  --models   one line per model under each day (local, plan or cloud)",
  "  --json     the same figures as JSON",
  "  --daily    accepted; the per-day view is the default",
  "Read from <stateDir>/usage-history.json. Nothing is sent anywhere.",
].join("\n");

export interface UsageCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Defaults to the history in the resolved state dir. */
  readHistory?: () => UsageHistoryFile;
  /** Today's day key; defaults to the spend day under `costTracking.dailyResetHourUtc`. */
  today?: () => string;
}

export async function usageCommand(args: string[], deps: UsageCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  let days: number | "all" = 7;
  let models = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      write(`${HELP}\n`);
      return 0;
    } else if (arg === "--all") {
      days = "all";
    } else if (arg === "--models") {
      models = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--daily") {
      // The default view; accepted so `usage --daily` reads like `ccusage daily`.
    } else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[++i] : arg.slice("--days=".length);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        writeErr(`--days needs a whole number of days, 1 or more\n\n${HELP}\n`);
        return 2;
      }
      days = n;
    } else {
      writeErr(`unknown option ${arg}\n\n${HELP}\n`);
      return 2;
    }
  }
  const history = (deps.readHistory ?? (() => readUsageHistory(join(resolveStateDir(), USAGE_HISTORY_FILE_NAME))))();
  const today = (deps.today ?? defaultToday)();
  const summary = summarizeUsageHistory(history, { days, today });
  if (json) {
    // Without `--models` the per-model lines stay out of the JSON too.
    const out = models ? summary : { ...summary, days: summary.days.map((d) => ({ ...d, models: undefined })) };
    write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    write(`${formatUsageHistory(summary, { models })}\n`);
  }
  return 0;
}

function defaultToday(): string {
  let resetHour = 0;
  try {
    resetHour = getConfig().llm?.costTracking?.dailyResetHourUtc ?? 0;
  } catch {
    // A broken config must not hide the history; midnight UTC is the default day.
  }
  return spendDayKey(Date.now(), resetHour);
}
