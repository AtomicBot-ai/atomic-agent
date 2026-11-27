import { getConfig } from "../config/index.js";
import {
  buildLogbookQuery,
  clampInterval,
  clampRetention,
  clearLogbookDays,
  clearLogbookRange,
  dayKey,
  describeWindow,
  formatLogbookEntries,
  listLogbookDays,
  logbookDir,
  parseClock,
  parseDaySpec,
  readLogbookDay,
  readLogbookSettings,
  readLogbookStatus,
  selectLogbookEntries,
  writeLogbookSettings,
  type LogbookSettings,
} from "../logbook/index.js";
import { recipeToLink, renderRecipePrompt, STANDUP_RECIPE } from "../recipes/index.js";

/**
 * `atomic-agent logbook ...` (ATO-2363): the switch and the reader for
 * the day journal. Writes only `<stateDir>/logbook/`; the capture loop
 * in a running Atomic Agent (TUI or desktop) picks a change up within
 * one scheduler tick. Precedents: OpenClaw's logbook plugin (state in
 * `<state-dir>/logbook/`) and Screenpipe; here the describing model is
 * always a local one.
 */
const HELP = [
  "atomic-agent logbook: a day journal from screenshots, described by a local model",
  "",
  "While it is on and Atomic Agent is open, it takes a screenshot every few minutes,",
  "has a vision model on THIS computer write one or two sentences about it, and",
  "deletes the picture right away. Only the sentences are kept, in",
  "<stateDir>/logbook/<day>.jsonl. Password managers, login prompts, system settings",
  "and Atomic Agent itself are never captured. No local vision model, no capture:",
  "screenshots never go to a cloud model. macOS only for now. Off by default.",
  "",
  "Subcommands:",
  "  start [--every <minutes>] [--keep <days>]   Turn it on (default every 5 min, kept 14 days)",
  "  stop                                        Turn it off (notes are kept)",
  "  pause [<minutes>]                           Pause for a while (default 60)",
  "  resume                                      End a pause",
  "  status [--json]                             On or off, last capture, what is kept",
  "  today | show <day> [--part morning|afternoon|evening] [--from HH:MM] [--to HH:MM] [--contains <words>]",
  "                                              Print the notes of a day",
  "  clear --all | --day <day> [--from HH:MM --to HH:MM] | --before <day>",
  "                                              Delete notes",
  "  exclude add|remove <app> | exclude list     Apps never captured (name or bundle id)",
  "  standup [--day <day>]                       Print the standup recipe and its link",
  "",
  "<day> is today, yesterday or YYYY-MM-DD.",
].join("\n");

export interface LogbookCommandDeps {
  stateDir?: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
}

class UsageError extends Error {}

export async function logbookCommand(args: string[], deps: LogbookCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => void process.stdout.write(t));
  const writeErr = deps.writeErr ?? ((t: string) => void process.stderr.write(t));
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help" || rest.includes("--help")) {
    write(`${HELP}\n`);
    return 0;
  }
  const env = {
    stateDir: deps.stateDir ?? getConfig().paths.stateDir,
    now: deps.now ?? (() => new Date()),
    platform: deps.platform ?? process.platform,
    write,
  };
  try {
    switch (sub) {
      case "start":
        return start(env, rest);
      case "stop":
        return update(env, (s) => ({ ...s, enabled: false, pausedUntil: null }), "Logbook stopped. Notes are kept; delete them with `atomic-agent logbook clear --all`.");
      case "pause": {
        const minutes = rest[0] === undefined ? 60 : Number(rest[0]);
        if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new UsageError("pause takes minutes, 1 to 1440");
        if (!readLogbookSettings(env.stateDir).enabled) throw new UsageError("the logbook is off; nothing to pause");
        const until = env.now().getTime() + Math.round(minutes) * 60_000;
        return update(env, (s) => ({ ...s, pausedUntil: until }), `Logbook paused until ${clock(new Date(until))}. Resume: atomic-agent logbook resume`);
      }
      case "resume":
        return update(env, (s) => ({ ...s, pausedUntil: null }), "Logbook resumed.");
      case "status":
        return status(env, rest.includes("--json"));
      case "today":
        return show(env, ["today", ...rest]);
      case "show":
        return show(env, rest);
      case "clear":
        return clear(env, rest);
      case "exclude":
        return exclude(env, rest);
      case "standup":
        return standup(env, rest);
      default:
        throw new UsageError(`unknown subcommand: ${sub}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      writeErr(`${err.message}\n\n${HELP}\n`);
      return 2;
    }
    writeErr(`logbook ${sub} failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

type Env = { stateDir: string; now: () => Date; platform: NodeJS.Platform; write: (text: string) => void };

function option(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  return value;
}

function update(env: Env, change: (s: LogbookSettings) => LogbookSettings, message: string): number {
  writeLogbookSettings(env.stateDir, change(readLogbookSettings(env.stateDir)));
  env.write(`${message}\n`);
  return 0;
}

function start(env: Env, args: readonly string[]): number {
  if (env.platform !== "darwin") {
    env.write("The logbook works on macOS only for now: it needs the front-app check that keeps password and login windows out.\n");
    return 1;
  }
  const every = option(args, "--every");
  const keep = option(args, "--keep");
  const current = readLogbookSettings(env.stateDir);
  const next: LogbookSettings = {
    ...current,
    enabled: true,
    pausedUntil: null,
    intervalMinutes: every === undefined ? current.intervalMinutes : clampInterval(Number(every)),
    retentionDays: keep === undefined ? current.retentionDays : clampRetention(Number(keep)),
  };
  writeLogbookSettings(env.stateDir, next);
  env.write(
    [
      `Logbook on: a screenshot every ${next.intervalMinutes} min while Atomic Agent is open.`,
      "Each one is described by a local vision model and deleted right after; screenshots never go to a cloud model.",
      `Notes are kept ${next.retentionDays} days in ${logbookDir(env.stateDir)}.`,
      "It needs a local model that can see images; `atomic-agent logbook status` says if one was found.",
      "Stop: atomic-agent logbook stop. Pause: atomic-agent logbook pause 30.",
    ].join("\n") + "\n",
  );
  return 0;
}

function status(env: Env, json: boolean): number {
  const settings = readLogbookSettings(env.stateDir);
  const last = readLogbookStatus(env.stateDir);
  const days = listLogbookDays(env.stateDir);
  const today = readLogbookDay(env.stateDir, dayKey(env.now())).length;
  const now = env.now().getTime();
  const state = !settings.enabled ? "off" : settings.pausedUntil !== null && now < settings.pausedUntil ? "paused" : "on";
  if (json) {
    env.write(`${JSON.stringify({ state, settings, last, days, notesToday: today, folder: logbookDir(env.stateDir) })}\n`);
    return 0;
  }
  const lines = [
    `Logbook: ${state.toUpperCase()}${state === "paused" ? ` until ${clock(new Date(settings.pausedUntil!))}` : ""}`,
    `Every ${settings.intervalMinutes} min, notes kept ${settings.retentionDays} days, in ${logbookDir(env.stateDir)}`,
    `Notes today: ${today}; days kept: ${days.length}${days.length > 0 ? ` (${days[0]} to ${days[days.length - 1]})` : ""}`,
  ];
  if (last.lastAttemptAt !== null) {
    const when = new Date(last.lastAttemptAt).toLocaleString();
    lines.push(`Last try: ${when}, ${last.lastOutcome ?? "unknown"}${last.lastReason ? `: ${last.lastReason}` : ""}${last.provider ? ` (model on ${last.provider})` : ""}`);
  } else if (settings.enabled) {
    lines.push("No capture yet: it runs while Atomic Agent (the terminal app or the desktop app) is open.");
  }
  if (settings.excludeApps.length > 0) lines.push(`Never captured, by you: ${settings.excludeApps.join(", ")}`);
  env.write(`${lines.join("\n")}\n`);
  return 0;
}

function show(env: Env, args: readonly string[]): number {
  const day = args[0];
  if (day === undefined || day.startsWith("--")) throw new UsageError("show needs a day: today, yesterday or YYYY-MM-DD");
  const query = buildLogbookQuery(
    { day, part: option(args, "--part"), from: option(args, "--from"), to: option(args, "--to"), contains: option(args, "--contains"), limit: 400 },
    env.now(),
  );
  const picked = selectLogbookEntries(readLogbookDay(env.stateDir, query.day), query);
  env.write(picked.length === 0 ? `No notes for ${describeWindow(query)}.\n` : `${formatLogbookEntries(picked)}\n`);
  return 0;
}

function clear(env: Env, args: readonly string[]): number {
  const day = option(args, "--day");
  const before = option(args, "--before");
  const all = args.includes("--all");
  const picked = [all, day !== undefined, before !== undefined].filter(Boolean).length;
  if (picked !== 1) throw new UsageError("clear takes one of --all, --day <day> or --before <day>");
  const from = option(args, "--from");
  const to = option(args, "--to");
  if ((from !== undefined || to !== undefined) && day === undefined) throw new UsageError("--from and --to go with --day");
  if (day !== undefined && (from !== undefined || to !== undefined)) {
    const key = parseDaySpec(day, env.now());
    const removed = clearLogbookRange(env.stateDir, key, from ? parseClock(from, "from") : 0, to ? parseClock(to, "to") : 24 * 60);
    env.write(`Deleted ${removed} note${removed === 1 ? "" : "s"} from ${key}.\n`);
    return 0;
  }
  const days = all
    ? clearLogbookDays(env.stateDir, { all: true })
    : day !== undefined
      ? clearLogbookDays(env.stateDir, { day: parseDaySpec(day, env.now()) })
      : clearLogbookDays(env.stateDir, { before: parseDaySpec(before, env.now()) });
  env.write(`Deleted ${days.length} day${days.length === 1 ? "" : "s"} of notes${days.length > 0 ? ` (${days.join(", ")})` : ""}.\n`);
  return 0;
}

function exclude(env: Env, args: readonly string[]): number {
  const [verb, ...words] = args;
  const settings = readLogbookSettings(env.stateDir);
  if (verb === "list" || verb === undefined) {
    env.write(settings.excludeApps.length === 0 ? "No apps excluded by you.\n" : `${settings.excludeApps.join("\n")}\n`);
    return 0;
  }
  const app = words.join(" ").trim();
  if (!app || (verb !== "add" && verb !== "remove")) throw new UsageError("exclude add|remove <app name or bundle id>");
  const others = settings.excludeApps.filter((item) => item.toLowerCase() !== app.toLowerCase());
  const excludeApps = verb === "add" ? [...others, app] : others;
  return update(env, (s) => ({ ...s, excludeApps }), verb === "add" ? `${app} will never be captured.` : `${app} removed from the excluded apps.`);
}

function standup(env: Env, args: readonly string[]): number {
  const day = option(args, "--day") ?? "yesterday";
  const link = recipeToLink(STANDUP_RECIPE);
  env.write(`${renderRecipePrompt(STANDUP_RECIPE, { day })}\n\n`);
  env.write(link.ok ? `Open in the desktop app: ${link.link}\n` : `${link.error}\n`);
  return 0;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
