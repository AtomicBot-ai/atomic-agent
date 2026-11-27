import { isStandupClock, readLogbookSettings, writeLogbookSettings } from "../logbook/index.js";

/**
 * ATO-2526: the logbook's newer switches, beside `logbook-command.ts`:
 *
 *   title-only add|remove <app> | title-only list
 *       apps noted by window title only: no screenshot, no model call
 *   standup --every-morning HH:MM | standup --off
 *       write the standup every morning at that time, as a scheduled task
 *       (filed by the running app within a minute; off by default)
 *
 * Both write `<stateDir>/logbook/settings.json` only, like the rest.
 */
export const MORE_HELP_LINES = [
  "  title-only add|remove <app> | title-only list  Apps noted by window title only (no screenshot)",
  "  standup --every-morning HH:MM | standup --off   Write the standup every morning (a scheduled task)",
];

interface MoreEnv {
  stateDir: string;
  write: (text: string) => void;
}

export function titleOnlyCommand(env: MoreEnv, args: readonly string[]): number {
  const [verb, ...words] = args;
  const settings = readLogbookSettings(env.stateDir);
  if (verb === "list" || verb === undefined) {
    env.write(settings.titleOnlyApps.length === 0 ? "No apps are noted by title only.\n" : `${settings.titleOnlyApps.join("\n")}\n`);
    return 0;
  }
  const app = words.join(" ").trim();
  if (!app || (verb !== "add" && verb !== "remove")) {
    env.write("usage: atomic-agent logbook title-only add|remove <app name or id> | title-only list\n");
    return 2;
  }
  const others = settings.titleOnlyApps.filter((item) => item.toLowerCase() !== app.toLowerCase());
  writeLogbookSettings(env.stateDir, { ...settings, titleOnlyApps: verb === "add" ? [...others, app] : others });
  env.write(
    verb === "add"
      ? `${app} will be noted by its window title only: no screenshot, no model.\n`
      : `${app} will be described from screenshots again.\n`,
  );
  return 0;
}

/** `standup --every-morning HH:MM` or `--off`; `null` when the args ask for neither (print the recipe instead). */
export function standupScheduleCommand(env: MoreEnv, args: readonly string[]): number | null {
  const i = args.indexOf("--every-morning");
  const off = args.includes("--off");
  if (i < 0 && !off) return null;
  const settings = readLogbookSettings(env.stateDir);
  if (off) {
    writeLogbookSettings(env.stateDir, { ...settings, standupAt: null });
    env.write("The morning standup is off; its scheduled task is removed within a minute while Atomic Agent runs.\n");
    return 0;
  }
  const at = args[i + 1];
  if (!isStandupClock(at)) {
    env.write("usage: atomic-agent logbook standup --every-morning HH:MM (24-hour, like 09:00) | standup --off\n");
    return 2;
  }
  writeLogbookSettings(env.stateDir, { ...settings, standupAt: at });
  env.write(
    [
      `The standup will be written every day at ${at} from yesterday's notes, as a scheduled task.`,
      settings.enabled ? "It is filed within a minute while Atomic Agent runs." : "It starts once the logbook is on: atomic-agent logbook start.",
      "Turn it off: atomic-agent logbook standup --off",
    ].join("\n") + "\n",
  );
  return 0;
}
