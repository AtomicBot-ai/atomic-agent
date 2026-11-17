/**
 * Parsing for the Telegram `/cron` command (ATO-21). Pure: turns the
 * text after `/cron` into one of the subcommands below, or a usage
 * error. Whether a cron expression is valid is not decided here; the
 * command checks it with the core's own `validateSchedule`.
 *
 *   /cron                         list (same as `/cron list`)
 *   /cron add [--tz <zone>] <expr> <message>
 *   /cron pause <id>
 *   /cron resume <id>
 *   /cron delete <id>
 *   /cron help
 *
 * `<expr>` is either quoted (any number of fields, e.g. a 6-field
 * expression with seconds), a single `@daily`-style macro, or the first
 * five words. Telegram clients turn straight quotes into curly ones, so
 * both kinds are accepted.
 */

export type CronCommand =
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "add"; expression: string; tz?: string; message: string }
  | { kind: "pause" | "resume" | "delete"; id: string }
  | { kind: "error"; message: string };

export const CRON_USAGE =
  "Scheduled tasks from Telegram:\n" +
  "  /cron — list scheduled tasks\n" +
  "  /cron add <cron> <what to do> — e.g. /cron add 0 9 * * 1-5 summarise my inbox\n" +
  '  /cron add --tz Europe/Berlin "0 9 * * *" morning digest\n' +
  "  /cron pause <id>, /cron resume <id>, /cron delete <id>\n" +
  "The cron is 5 fields (minute hour day month weekday), or @hourly / @daily / @weekly / @monthly. " +
  "Without --tz it runs on this computer's local time. Results come back to this bot.";

const VERB_ALIASES: Record<string, Exclude<CronCommand["kind"], "error">> = {
  list: "list",
  ls: "list",
  add: "add",
  create: "add",
  new: "add",
  pause: "pause",
  stop: "pause",
  resume: "resume",
  start: "resume",
  delete: "delete",
  del: "delete",
  rm: "delete",
  remove: "delete",
  help: "help",
};

/** Opening quote -> the closing quotes that end it. */
const QUOTES: Record<string, string> = {
  '"': '"”',
  "“": '”"',
  "'": "'’",
  "‘": "’'",
};

const CRON_FIELDS = 5;

export function parseCronCommand(raw: string): CronCommand {
  const text = raw.trim();
  if (text.length === 0) return { kind: "list" };
  const [verbRaw = "", rest = ""] = splitFirstWord(text);
  const kind = VERB_ALIASES[verbRaw.toLowerCase()];
  if (!kind) {
    return { kind: "error", message: `Unknown /cron subcommand: ${verbRaw}\n\n${CRON_USAGE}` };
  }
  if (kind === "list" || kind === "help") return { kind };
  if (kind === "add") return parseAdd(rest);
  const id = rest.trim().split(/\s+/)[0] ?? "";
  if (id.length === 0) {
    return { kind: "error", message: `Usage: /cron ${verbRaw.toLowerCase()} <id>. Send /cron to see the ids.` };
  }
  return { kind, id };
}

function parseAdd(input: string): CronCommand {
  let rest = input.trim();
  let tz: string | undefined;
  const tzMatch = /^--tz(?:=|\s+)(\S+)\s*/u.exec(rest);
  if (tzMatch) {
    tz = tzMatch[1];
    rest = rest.slice(tzMatch[0].length);
  }
  const split = splitExpression(rest);
  if (split === null) {
    return { kind: "error", message: `Usage: /cron add <cron> <what to do>\n\n${CRON_USAGE}` };
  }
  if ("error" in split) return { kind: "error", message: split.error };
  const message = split.rest.trim();
  if (message.length === 0) {
    return {
      kind: "error",
      message: `Say what the task should do after the cron, e.g. /cron add ${split.expression} summarise my inbox`,
    };
  }
  return { kind: "add", expression: split.expression, ...(tz ? { tz } : {}), message };
}

function splitExpression(
  text: string,
): { expression: string; rest: string } | { error: string } | null {
  if (text.length === 0) return null;
  const closers = QUOTES[text[0]!];
  if (closers) {
    let end = -1;
    for (let i = 1; i < text.length; i += 1) {
      if (closers.includes(text[i]!)) {
        end = i;
        break;
      }
    }
    if (end === -1) return { error: "The cron expression has an opening quote but no closing one." };
    const expression = text.slice(1, end).trim().replace(/\s+/g, " ");
    if (expression.length === 0) return { error: "The cron expression is empty." };
    return { expression, rest: text.slice(end + 1) };
  }
  if (text.startsWith("@")) {
    const [macro = "", rest = ""] = splitFirstWord(text);
    return { expression: macro, rest };
  }
  const fields: string[] = [];
  let rest = text;
  while (fields.length < CRON_FIELDS) {
    const [word, after] = splitFirstWord(rest);
    if (!word) break;
    fields.push(word);
    rest = after;
  }
  if (fields.length < CRON_FIELDS) {
    return {
      error: `A cron needs ${CRON_FIELDS} fields (minute hour day month weekday), got ${fields.length}: ${fields.join(" ")}`,
    };
  }
  return { expression: fields.join(" "), rest };
}

/** `"add 0 9 * * * x"` -> `["add", "0 9 * * * x"]`; keeps the rest's inner whitespace. */
function splitFirstWord(text: string): [string, string] {
  const trimmed = text.replace(/^\s+/u, "");
  const match = /\s/u.exec(trimmed);
  if (!match) return [trimmed, ""];
  return [trimmed.slice(0, match.index), trimmed.slice(match.index + 1)];
}
