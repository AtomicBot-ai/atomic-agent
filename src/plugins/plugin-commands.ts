import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadEnabledPlugins } from "./plugin-runtime.js";
import { isPartDisabled, pluginDataDir } from "./plugin-store.js";

/**
 * A slash command from a plugin's `commands/**\/*.md` (Claude format).
 * The body is a prompt template: invoking `/plugin:name args` renders it
 * and sends the result as the user's message for that turn. Nothing in a
 * template is ever executed: `!` shell lines and `@file` includes stay
 * plain text.
 */
export interface PluginCommand {
  /** `plugin:command` (nested folders give `plugin:a:b`), lower-cased. */
  name: string;
  plugin: string;
  /** Command name inside the plugin (`commit`, `git:push`), lower-cased. */
  command: string;
  description: string;
  /** Frontmatter `argument-hint`, shown next to the command in the palette. */
  argumentHint?: string;
  /** Frontmatter `allowed-tools`; a hint only, never a grant. */
  allowedTools: string[];
  file: string;
  /** Plain-language notes about frontmatter we do not honour. */
  notes: string[];
}

export interface ParsedCommandFile {
  description: string;
  argumentHint?: string;
  allowedTools: string[];
  model?: string;
  body: string;
}

export interface CommandTemplateVars {
  root: string;
  data: string;
}

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_DESCRIPTION = 120;

export function parseCommandFile(content: string): ParsedCommandFile {
  const text = content.replace(/\r\n/g, "\n");
  let meta: Record<string, unknown> = {};
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      try {
        const parsed = parseYaml(text.slice(4, end));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      } catch {
        // Broken frontmatter: keep the body, fall back to defaults.
      }
      body = text.slice(end + 4).replace(/^[^\n]*\n/, "").replace(/^\n+/, "");
    }
  }
  const rawTools = meta["allowed-tools"];
  const allowedTools = Array.isArray(rawTools)
    ? rawTools.filter((t): t is string => typeof t === "string").map(t => t.trim()).filter(Boolean)
    : typeof rawTools === "string" ? rawTools.split(",").map(t => t.trim()).filter(Boolean) : [];
  const hint = meta["argument-hint"];
  const argumentHint = typeof hint === "string" ? hint.trim() : Array.isArray(hint) ? hint.map(String).join(" ") : "";
  const description = typeof meta.description === "string" && meta.description.trim()
    ? meta.description.trim()
    : firstLine(body);
  return {
    description: clip(description, MAX_DESCRIPTION),
    ...(argumentHint ? { argumentHint } : {}),
    allowedTools,
    ...(typeof meta.model === "string" && meta.model.trim() ? { model: meta.model.trim() } : {}),
    body,
  };
}

/**
 * Split an argument string the way Claude Code fills `$1`..`$9`:
 * whitespace-separated, with single or double quotes grouping words.
 */
export function splitCommandArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

const TEMPLATE_RE = /\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|PLUGIN_ROOT|PLUGIN_DATA)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS(?![A-Za-z0-9_])|\$([1-9])(?![0-9])/g;
const USES_ARGS_RE = /\$ARGUMENTS(?![A-Za-z0-9_])|\$ARGUMENTS\[\d+\]|\$[1-9](?![0-9])/;

/**
 * Render a command body with Claude semantics, in one pass so text that
 * came from the arguments is never substituted again:
 * - `$ARGUMENTS`: the whole argument string;
 * - `$1`..`$9`: positional arguments (1-based), `$ARGUMENTS[N]` (0-based);
 *   a missing one becomes empty;
 * - `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` (and the `PLUGIN_`
 *   spellings): the plugin folder and its data folder.
 * When the body uses no argument placeholder and arguments were given,
 * they are appended as `ARGUMENTS: ...`, as Claude Code does, so the
 * request is never dropped.
 */
export function renderCommandTemplate(body: string, args: string, vars: CommandTemplateVars): string {
  const trimmedArgs = args.trim();
  const positional = splitCommandArgs(trimmedArgs);
  const rendered = body.replace(TEMPLATE_RE, (_m, v: string | undefined, idx: string | undefined, pos: string | undefined) => {
    if (v) return v.endsWith("ROOT") ? vars.root : vars.data;
    if (idx !== undefined) return positional[Number(idx)] ?? "";
    if (pos !== undefined) return positional[Number(pos) - 1] ?? "";
    return trimmedArgs;
  });
  const out = rendered.trimEnd();
  if (trimmedArgs && !USES_ARGS_RE.test(body)) return `${out}\n\nARGUMENTS: ${trimmedArgs}`;
  return out;
}

/** Every enabled plugin command, minus the ones switched off with `command:<name>`. */
export function listPluginCommands(stateDir: string): { commands: PluginCommand[]; diagnostics: string[] } {
  const commands: PluginCommand[] = [];
  const loaded = loadEnabledPlugins(stateDir);
  const diagnostics: string[] = [...loaded.diagnostics];
  const seen = new Set<string>();
  for (const { record, bundle } of loaded.plugins) {
    for (const entry of bundle.commands) {
      if (isPartDisabled(record, `command:${entry.name}`)) continue;
      const command = entry.name.toLowerCase();
      const name = `${bundle.name}:${command}`;
      if (seen.has(name)) continue;
      try {
        const parsed = readCommandFile(entry.file);
        seen.add(name);
        commands.push({
          name,
          plugin: bundle.name,
          command,
          description: parsed.description,
          ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
          allowedTools: parsed.allowedTools,
          file: entry.file,
          notes: parsed.model ? [`model "${parsed.model}" is ignored; the command runs on the current model`] : [],
        });
      } catch (err) {
        diagnostics.push(`plugin ${bundle.name} command ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { commands, diagnostics };
}

/**
 * Short `/name` aliases for plugin commands: a command gets its bare name
 * only when no built-in or other entry claims it (`isTaken`) and no other
 * plugin ships a command with the same bare name. Returns name -> alias.
 */
export function shortCommandAliases(commands: readonly Pick<PluginCommand, "name" | "command">[], isTaken: (alias: string) => boolean): Map<string, string> {
  const counts = new Map<string, number>();
  for (const c of commands) counts.set(c.command, (counts.get(c.command) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const c of commands) {
    if (counts.get(c.command) !== 1 || isTaken(c.command)) continue;
    out.set(c.name, c.command);
  }
  return out;
}

/**
 * Render `/plugin:command args` into the text sent as the user's message.
 * Re-reads the plugin state, so a command switched off after the palette
 * was drawn fails here instead of running.
 */
export function renderPluginCommand(stateDir: string, name: string, args: string): string {
  const key = name.toLowerCase();
  for (const { record, bundle } of loadEnabledPlugins(stateDir).plugins) {
    for (const entry of bundle.commands) {
      if (`${bundle.name}:${entry.name.toLowerCase()}` !== key) continue;
      if (isPartDisabled(record, `command:${entry.name}`)) throw new Error(`plugin command /${key} is turned off`);
      const parsed = readCommandFile(entry.file);
      return renderCommandTemplate(parsed.body, args, { root: bundle.root, data: pluginDataDir(stateDir, bundle.name) });
    }
  }
  throw new Error(`plugin command /${key} is not available; is its plugin enabled?`);
}

function readCommandFile(file: string): ParsedCommandFile {
  if (statSync(file).size > MAX_COMMAND_BYTES) throw new Error("larger than 128 KiB");
  return parseCommandFile(readFileSync(file, "utf8"));
}

function firstLine(body: string): string {
  const line = body.split("\n").map(l => l.trim()).find(l => l.length > 0) ?? "";
  return line.replace(/^#+\s*/, "");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
