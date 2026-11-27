import type { UsageHistoryFile } from "../session/usage-history.js";
import { buildUsageReport, usageReportJson } from "../session/usage-report.js";
import { parseUsageArgs, usageHelp } from "../session/usage-report-args.js";
import {
  readDefaultUsageHistory,
  usageReferenceProviders,
  usageToday,
  type UsageReferenceProviders,
} from "../session/usage-report-defaults.js";
import { formatUsageReportText } from "../session/usage-report-format.js";

/**
 * ATO-2352, ATO-2442 — `atag usage`: tokens and cloud cost per day,
 * across every session, from `<stateDir>/usage-history.json`, with the
 * tool, project and session splits and the "saved by local" estimate.
 * Read-only. Precedent: `ccusage daily`, Claude Code `/usage`, OpenCode
 * `stats --days --tools --models --project`.
 */
const HELP = usageHelp("atomic-agent usage");

export interface UsageCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Defaults to the history in the resolved state dir. */
  readHistory?: () => UsageHistoryFile;
  /** Today's day key; defaults to the spend day under `costTracking.dailyResetHourUtc`. */
  today?: () => string;
  /** The configured providers, for "saved by local"'s reference model; defaults to the config's. */
  providers?: () => UsageReferenceProviders;
}

export async function usageCommand(args: string[], deps: UsageCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const parsed = parseUsageArgs(args);
  if (!parsed.ok) {
    writeErr(`${parsed.error}\n\n${HELP}\n`);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    write(`${HELP}\n`);
    return 0;
  }
  const history = (deps.readHistory ?? (() => readDefaultUsageHistory()))();
  const today = (deps.today ?? (() => usageToday()))();
  const report = buildUsageReport(history, {
    days: options.days,
    today,
    compare: options.compare,
    ...(deps.providers ?? usageReferenceProviders)(),
  });
  if (options.json) {
    write(`${JSON.stringify(usageReportJson(report, options), null, 2)}\n`);
  } else {
    write(`${formatUsageReportText(report, options)}\n`);
  }
  return 0;
}
