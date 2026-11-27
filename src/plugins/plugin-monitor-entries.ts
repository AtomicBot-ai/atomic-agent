import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest, PluginMonitorEntry } from "./plugin-types.js";

/**
 * Reads the monitors a plugin declares (ATO-2438), in Claude Code's shape:
 * `experimental.monitors` in plugin.json (a path or the array itself),
 * else `monitors/monitors.json`. Each entry is `{name, command,
 * description, when?}`; we also read `until`, a line pattern. Like Claude
 * Code, an entry with an unknown key is not loaded, but here only that
 * entry is skipped, with a note, and the rest of the plugin still loads.
 * Reading never runs anything.
 */

const MAX_MONITORS = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_COMMAND_CHARS = 4096;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KNOWN_KEYS = new Set(["name", "command", "description", "when", "until"]);

export interface MonitorEntriesRead {
  monitors: PluginMonitorEntry[];
  /** The file the entries came from, when they came from one. */
  file?: string;
  notes: string[];
}

export function readMonitorEntries(root: string, manifest: PluginManifest): MonitorEntriesRead {
  const notes: string[] = [];
  if (manifest.monitorsInline) return { monitors: parseMonitorEntries(manifest.monitorsInline, notes), notes };
  const file = manifest.monitorsPath ?? join(root, "monitors", "monitors.json");
  if (!isFile(file)) {
    if (manifest.monitorsPath) notes.push(`Skipped "monitors": ${manifest.monitorsPath} is not a file.`);
    return { monitors: [], notes };
  }
  let raw: unknown;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) throw new Error("larger than 256 KiB");
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    notes.push(`Skipped "monitors": ${file} could not be read (${err instanceof Error ? err.message : String(err)}).`);
    return { monitors: [], file, notes };
  }
  // The file holds the array; `{ "monitors": [...] }` is read too.
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).monitors) ? (raw as Record<string, unknown>).monitors as unknown[] : null;
  if (!list) {
    notes.push(`Skipped "monitors": ${file} must hold an array of monitors.`);
    return { monitors: [], file, notes };
  }
  return { monitors: parseMonitorEntries(list, notes), file, notes };
}

/** Valid entries in order; every skipped one leaves a note saying why. */
export function parseMonitorEntries(list: readonly unknown[], notes: string[]): PluginMonitorEntry[] {
  const out: PluginMonitorEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const label = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).name === "string"
      ? `monitor "${(raw as Record<string, unknown>).name as string}"`
      : `monitor #${index + 1}`;
    const skip = (why: string) => notes.push(`Skipped ${label}: ${why}.`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { skip("not an object"); continue; }
    const entry = raw as Record<string, unknown>;
    const unknown = Object.keys(entry).filter(k => !KNOWN_KEYS.has(k));
    if (unknown.length) { skip(`unknown key ${unknown.map(k => JSON.stringify(k)).join(", ")}`); continue; }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!NAME_RE.test(name)) { skip("needs a `name` of letters, digits, '.', '_' or '-'"); continue; }
    if (seen.has(name)) { skip("the name is used twice"); continue; }
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command) { skip("needs a `command`"); continue; }
    if (command.length > MAX_COMMAND_CHARS) { skip("the command is too long"); continue; }
    // Claude Code refuses these in a shell command: a value put into it would be parsed again by the shell.
    if (command.includes("${user_config.")) { skip("a monitor command cannot use ${user_config.*}"); continue; }
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (!description) { skip("needs a `description`"); continue; }
    const when = entry.when === undefined ? "always" : entry.when;
    if (typeof when === "string" && when.startsWith("on-skill-invoke:")) {
      skip(`it starts when a skill runs (${when}), which is not supported yet`);
      continue;
    }
    if (when !== "always") { skip("`when` must be \"always\" or \"on-skill-invoke:<skill>\""); continue; }
    let until: string | undefined;
    if (entry.until !== undefined) {
      if (typeof entry.until !== "string" || !entry.until.trim()) { skip("`until` must be a non-empty pattern"); continue; }
      try { new RegExp(entry.until, "i"); } catch { skip("`until` is not a valid pattern"); continue; }
      until = entry.until;
    }
    if (out.length >= MAX_MONITORS) { skip(`a plugin declares at most ${MAX_MONITORS} monitors`); continue; }
    seen.add(name);
    out.push({ name, command, description, ...(until !== undefined ? { until } : {}) });
  }
  return out;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
