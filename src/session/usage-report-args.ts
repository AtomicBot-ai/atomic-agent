/**
 * The options of the usage report (ATO-2352, ATO-2442), shared by
 * `atomic-agent usage` and the TUI's `/usage`, so both take the same
 * words. Precedent: OpenCode `stats --days N --tools --models
 * --project`, `ccusage daily --json`.
 */
export interface UsageReportOptions {
  days: number | "all";
  models: boolean;
  tools: boolean;
  projects: boolean;
  sessions: boolean;
  json: boolean;
  /** The cloud model "saved by local" is priced at; `null` picks one (see usage-saved-by-local.ts). */
  compare: string | null;
  help: boolean;
}

export type ParsedUsageArgs = { ok: true; options: UsageReportOptions } | { ok: false; error: string };

export const DEFAULT_USAGE_DAYS = 7;

export function usageHelp(command: string): string {
  return [
    `Usage: ${command} [--days N | --all] [--models] [--tools] [--projects] [--sessions] [--compare <model>] [--json]`,
    "",
    "Tokens and cost per day, over every session (terminal and desktop app).",
    `  --days N           the last N days, today included (default ${DEFAULT_USAGE_DAYS})`,
    "  --all              every day on record",
    "  --models           one line per model under each day (local, plan or cloud)",
    "  --tools            tool calls per tool over the window",
    "  --projects         tokens and cost per project folder",
    "  --sessions         a column with the number of chats that made a call each day",
    "  --compare <model>  the cloud model \"saved by local\" is priced at, as provider/model",
    "                     (deepseek/deepseek-v4-flash) or a model id; default: your own cloud",
    "                     model, else a cheap widely used one. Always an estimate.",
    "  --json             the same figures as JSON",
    "  --daily            accepted; the per-day view is the default",
    "Read from <stateDir>/usage-history.json. Nothing is sent anywhere.",
  ].join("\n");
}

export function parseUsageArgs(args: readonly string[]): ParsedUsageArgs {
  const options: UsageReportOptions = {
    days: DEFAULT_USAGE_DAYS,
    models: false,
    tools: false,
    projects: false,
    sessions: false,
    json: false,
    compare: null,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || arg === "") continue;
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--all") options.days = "all";
    else if (arg === "--models") options.models = true;
    else if (arg === "--tools") options.tools = true;
    else if (arg === "--projects" || arg === "--project") options.projects = true;
    else if (arg === "--sessions") options.sessions = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--daily") {
      // The default view; accepted so `usage --daily` reads like `ccusage daily`.
    } else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[++i] : arg.slice("--days=".length);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: "--days needs a whole number of days, 1 or more" };
      options.days = n;
    } else if (arg === "--compare" || arg.startsWith("--compare=")) {
      const value = (arg === "--compare" ? args[++i] : arg.slice("--compare=".length))?.trim();
      if (!value || value.startsWith("--")) return { ok: false, error: "--compare needs a model, like deepseek/deepseek-v4-flash" };
      options.compare = value;
    } else {
      return { ok: false, error: `unknown option ${arg}` };
    }
  }
  return { ok: true, options };
}
