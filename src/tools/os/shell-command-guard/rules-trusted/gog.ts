import { basenameCommand } from "../normalise.js";
import type { Rule } from "../guard-types.js";

const SAFE_GOG_ENABLE_COMMANDS: ReadonlySet<string> = new Set([
  "admin.groups.list",
  "admin.groups.members.list",
  "admin.orgunits.get",
  "admin.orgunits.list",
  "admin.users.get",
  "admin.users.list",
  "agent.exit-codes",
  "analytics.accounts",
  "analytics.report",
  "appscript.content",
  "appscript.get",
  "auth.alias.list",
  "auth.credentials.list",
  "auth.list",
  "auth.service-account.status",
  "auth.services",
  "auth.status",
  "auth.tokens.list",
  "calendar.acl",
  "calendar.alias.list",
  "calendar.appointments",
  "calendar.calendars",
  "calendar.colors",
  "calendar.conflicts",
  "calendar.event",
  "calendar.events",
  "calendar.freebusy",
  "calendar.get",
  "calendar.list",
  "calendar.raw",
  "calendar.search",
  "calendar.team",
  "calendar.time",
  "calendar.users",
  "chat.messages.list",
  "chat.messages.reactions.list",
  "chat.spaces.find",
  "chat.spaces.list",
  "chat.threads.list",
  "classroom.announcements.get",
  "classroom.announcements.list",
  "classroom.courses.get",
  "classroom.courses.list",
  "classroom.courses.url",
  "classroom.coursework.get",
  "classroom.coursework.list",
  "classroom.guardian-invitations.get",
  "classroom.guardian-invitations.list",
  "classroom.guardians.get",
  "classroom.guardians.list",
  "classroom.invitations.get",
  "classroom.invitations.list",
  "classroom.materials.get",
  "classroom.materials.list",
  "classroom.profile.get",
  "classroom.roster",
  "classroom.students.get",
  "classroom.students.list",
  "classroom.submissions.get",
  "classroom.submissions.list",
  "classroom.teachers.get",
  "classroom.teachers.list",
  "classroom.topics.get",
  "classroom.topics.list",
  "contacts.dedupe",
  "contacts.directory.list",
  "contacts.directory.search",
  "contacts.get",
  "contacts.list",
  "contacts.other.list",
  "contacts.other.search",
  "contacts.raw",
  "contacts.search",
  "docs.cat",
  "docs.comments.get",
  "docs.comments.list",
  "docs.info",
  "docs.list-tabs",
  "docs.raw",
  "docs.structure",
  "docs.tabs.list",
  "drive.activity.query",
  "drive.audit.sharing",
  "drive.audit.user",
  "drive.changes.list",
  "drive.changes.start-token",
  "drive.comments.get",
  "drive.comments.list",
  "drive.drives",
  "drive.du",
  "drive.get",
  "drive.inventory",
  "drive.labels.file.list",
  "drive.labels.get",
  "drive.labels.list",
  "drive.ls",
  "drive.permissions",
  "drive.raw",
  "drive.search",
  "drive.tree",
  "drive.url",
  "exit-codes",
  "forms.get",
  "forms.raw",
  "forms.responses.get",
  "forms.responses.list",
  "gmail.drafts.get",
  "gmail.drafts.list",
  "gmail.get",
  "gmail.labels.get",
  "gmail.labels.list",
  "gmail.messages.search",
  "gmail.raw",
  "gmail.search",
  "gmail.settings.autoforward.get",
  "gmail.settings.delegates.get",
  "gmail.settings.delegates.list",
  "gmail.settings.filters.get",
  "gmail.settings.filters.list",
  "gmail.settings.forwarding.get",
  "gmail.settings.forwarding.list",
  "gmail.settings.sendas.get",
  "gmail.settings.sendas.list",
  "gmail.settings.vacation.get",
  "gmail.settings.watch.status",
  "gmail.thread.attachments",
  "gmail.thread.get",
  "gmail.track.opens",
  "gmail.track.status",
  "gmail.url",
  "groups.list",
  "groups.members",
  "keep.get",
  "keep.list",
  "keep.search",
  "ls",
  "maps.directions",
  "maps.distance",
  "maps.geocode",
  "maps.places.details",
  "maps.places.search",
  "maps.reverse-geocode",
  "me",
  "meet.get",
  "meet.history",
  "meet.participants",
  "open",
  "people.get",
  "people.me",
  "people.raw",
  "people.relations",
  "people.search",
  "photos.get",
  "photos.list",
  "photos.search",
  "schema",
  "search",
  "searchconsole.query",
  "searchconsole.searchanalytics.query",
  "searchconsole.sitemaps.get",
  "searchconsole.sitemaps.list",
  "searchconsole.sites.get",
  "searchconsole.sites.list",
  "sheets.banding.list",
  "sheets.chart.get",
  "sheets.chart.list",
  "sheets.conditional-format.list",
  "sheets.get",
  "sheets.links",
  "sheets.metadata",
  "sheets.named-ranges.get",
  "sheets.named-ranges.list",
  "sheets.notes",
  "sheets.raw",
  "sheets.read-format",
  "sheets.table.get",
  "sheets.table.list",
  "sites.get",
  "sites.list",
  "sites.search",
  "sites.url",
  "slides.info",
  "slides.list-slides",
  "slides.raw",
  "slides.read-slide",
  "status",
  "tasks.get",
  "tasks.list",
  "tasks.lists.list",
  "tasks.raw",
  "time.now",
  "version",
  "whoami",
  "youtube.activities.list",
  "youtube.channels.list",
  "youtube.comments.list",
  "youtube.playlists.list",
  "youtube.videos.list",
  "zoom.auth.doctor",
]);

const SAFE_GOG_AUTH_COMMANDS: ReadonlySet<string> = new Set([
  "auth.alias.list",
  "auth.credentials.list",
  "auth.list",
  "auth.service-account.status",
  "auth.services",
  "auth.status",
  "auth.tokens.list",
  "status",
]);

const GOG_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--account",
  "--config",
  "--enable-commands",
  "--keyring-backend",
  "--keyring-dir",
]);

const DANGEROUS_GOG_WORDS: ReadonlySet<string> = new Set([
  "add",
  "create",
  "credentials",
  "delete",
  "draft",
  "grant",
  "login",
  "manage",
  "modify",
  "patch",
  "remove",
  "send",
  "share",
  "trash",
  "update",
]);

export function isGogCommand(cmd: string): boolean {
  return basenameCommand(cmd).normalize("NFKC").toLowerCase() === "gog";
}

export const gogReadOnlyRule: Rule = {
  id: "gog.read_only",
  layer: "trusted",
  match(input) {
    if (input.cmd !== "gog") return null;
    if (isSafeAuthRead(input.args)) {
      return {
        action: "allow",
        rule: "gog.auth_read",
        reason: "gog auth read-only command",
      };
    }
    if (!input.args.includes("--no-input")) return null;
    if (containsDangerousWord(input.args)) return null;
    const enabled = readEnabledCommands(input.args);
    if (enabled.length === 0) return null;
    if (!enabled.every((name) => SAFE_GOG_ENABLE_COMMANDS.has(name))) return null;
    return {
      action: "allow",
      rule: "gog.read_only",
      reason: `gog read-only command (${enabled.join(",")})`,
    };
  },
};

function isSafeAuthRead(args: readonly string[]): boolean {
  const command = readCommandWords(args);
  const commandName = command.join(".");
  if (SAFE_GOG_AUTH_COMMANDS.has(commandName)) return true;
  return (
    command[0] === "auth" &&
    command[1] === "doctor" &&
    args.includes("--check") &&
    args.includes("--no-input")
  );
}

function readCommandWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GOG_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    words.push(arg);
  }
  return words;
}

function containsDangerousWord(args: readonly string[]): boolean {
  for (const word of readCommandWords(args)) {
    if (DANGEROUS_GOG_WORDS.has(word.toLowerCase())) return true;
  }
  return false;
}

function readEnabledCommands(args: readonly string[]): string[] {
  const idx = args.indexOf("--enable-commands");
  if (idx === -1) return [];
  const raw = args[idx + 1];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
