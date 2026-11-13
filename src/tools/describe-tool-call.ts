/**
 * A tool call as a person would say it (ATO-962).
 *
 * The TUI card, the Telegram progress line and the desktop all showed the
 * raw call (`os.fs.read path="/Users/…/src/config.ts"`). This module turns
 * one call into one short English line: "Read config.ts", "Ran npm test ·
 * failed", "Searched the web for “bun vs node”". It is the shared source
 * of that wording; the desktop renderer keeps a richer local copy (it
 * also reads the call's output) and takes `line` from the stream frames
 * for tools its table does not know.
 *
 * Three forms per call:
 *  - running: present participle, "Reading config.ts"
 *  - ok: past tense, "Read config.ts"
 *  - error: "Couldn't read config.ts"; a command that ran and exited
 *    non-zero did run, so it keeps the past tense: "Ran npm test · failed".
 *
 * Pure and dependency-free: args are untrusted model output, so every
 * field is read defensively and nothing here throws.
 */

import { canonicalArgs } from "./argument-aliases.js";

export type ToolCallStatus = "running" | "ok" | "error";

export interface DescribeToolCallInput {
  /** Registered tool name, e.g. `os.fs.read` or `mcp.github.create_issue`. */
  name: string;
  /** The call's arguments as parsed from the model (object or JSON text). */
  args?: unknown;
  /** Unset while running; `true` finished fine; `false` failed or was refused. */
  ok?: boolean;
  /** The failure in a few words, when known. Goes to `detail`, never `line`. */
  error?: string;
  /** Accepted for callers that pass a whole result; timing is shown by them. */
  durationMs?: number;
}

export interface ToolCallDescription {
  /** The leading verb in the form `status` asks for: "Read", "Reading", "Couldn't read". */
  verb: string;
  /** The whole one-line description. Never longer than {@link MAX_LINE}. */
  line: string;
  /** The failure's first line (errors only), clipped. */
  detail?: string;
  status: ToolCallStatus;
}

/** Longest `line` this module returns; callers may clip harder to fit. */
export const MAX_LINE = 96;
const MAX_COMMAND = 60;
const MAX_QUOTE = 48;
const MAX_DETAIL = 120;

/** A verb in its three forms: past ("Read"), -ing ("Reading"), base ("read"). */
type Verb = readonly [past: string, ing: string, base: string];

interface Phrase {
  verb: Verb;
  /** Text after the verb, with its leading space; "" for none. */
  rest: string;
  /** A failure still happened (a command ran and exited non-zero). */
  ranAnyway?: boolean;
}

const V = {
  read: ["Read", "Reading", "read"],
  wrote: ["Wrote", "Writing", "write"],
  addedTo: ["Added to", "Adding to", "add to"],
  edited: ["Edited", "Editing", "edit"],
  listed: ["Listed", "Listing", "list"],
  lookedFor: ["Looked for", "Looking for", "look for"],
  lookedAt: ["Looked at", "Looking at", "look at"],
  lookedUp: ["Looked up", "Looking up", "look up"],
  searched: ["Searched", "Searching", "search"],
  moved: ["Moved", "Moving", "move"],
  compared: ["Compared", "Comparing", "compare"],
  restored: ["Restored", "Restoring", "restore"],
  extracted: ["Extracted", "Extracting", "extract"],
  checked: ["Checked", "Checking", "check"],
  watched: ["Watched", "Watching", "watch"],
  found: ["Found", "Finding", "find"],
  ran: ["Ran", "Running", "run"],
  stopped: ["Stopped", "Stopping", "stop"],
  opened: ["Opened", "Opening", "open"],
  called: ["Called", "Calling", "call"],
  clicked: ["Clicked", "Clicking", "click"],
  typed: ["Typed", "Typing", "type"],
  scrolled: ["Scrolled", "Scrolling", "scroll"],
  switched: ["Switched", "Switching", "switch"],
  remembered: ["Remembered", "Remembering", "remember"],
  recalled: ["Recalled", "Recalling", "recall"],
  forgot: ["Forgot", "Forgetting", "forget"],
  generated: ["Generated", "Generating", "generate"],
  delegated: ["Delegated", "Delegating", "delegate"],
  scheduled: ["Scheduled", "Scheduling", "schedule"],
  cancelled: ["Cancelled", "Cancelling", "cancel"],
  copied: ["Copied", "Copying", "copy"],
  sent: ["Sent", "Sending", "send"],
  created: ["Created", "Creating", "create"],
  commented: ["Commented", "Commenting", "comment"],
  focused: ["Focused", "Focusing", "focus"],
  used: ["Used", "Using", "use"],
} as const satisfies Record<string, Verb>;

// ---------------------------------------------------------------------------
// Argument helpers (defensive: args are model output)

function argsObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const v: unknown = JSON.parse(args);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* clipped or not JSON: no args */
    }
  }
  return {};
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() === "" ? undefined : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Clip to `n` characters with an ellipsis. */
export function clip(s: string, n: number): string {
  const t = oneLine(s);
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
}

/** "/Users/x/src/config.ts" → "config.ts"; "src/" → "src"; "." → "this folder". */
export function shortPath(p: string): string {
  const t = p.trim().replace(/[\\/]+$/, "");
  if (t === "" || t === "." || t === "./") return "this folder";
  if (t === "~") return "home folder";
  const base = t.split(/[\\/]/).pop() ?? t;
  return clip(base === "" ? t : base, 40);
}

function quote(s: string): string {
  return `“${clip(s, MAX_QUOTE)}”`;
}

function host(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return clip(u.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? u, 40);
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The path (or first of `paths`) and how many more there are. */
function pathsOf(a: Record<string, unknown>): { first?: string; more: number } {
  const single = str(a.path) ?? str(a.file) ?? str(a.file_path);
  if (single) return { first: single, more: 0 };
  const list = Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
  return list.length > 0 ? { first: list[0], more: list.length - 1 } : { more: 0 };
}

function fileObject(a: Record<string, unknown>, fallback: string): string {
  const { first, more } = pathsOf(a);
  if (!first) return fallback;
  return shortPath(first) + (more > 0 ? ` and ${more} more` : "");
}

/** `cmd` + `args`, first line, clipped; "(+N lines)" when it is a script. */
function commandText(a: Record<string, unknown>): string | undefined {
  const asList = (v: unknown): string | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? v.join(" ") : undefined;
  const cmd = str(a.cmd) ?? str(a.command) ?? asList(a.cmd) ?? asList(a.command);
  if (!cmd) return undefined;
  const argv = Array.isArray(a.args) ? a.args.filter((x) => typeof x === "string" || typeof x === "number").map(String) : [];
  const full = [cmd, ...argv].join(" ").trim();
  const lines = full.split("\n");
  const firstLine = clip(lines[0] ?? full, MAX_COMMAND);
  const extra = lines.length - 1;
  return extra > 0 ? `${firstLine} (+${plural(extra, "line")})` : firstLine;
}

/** "github.create_issue" → "create issue"; "GMAIL_SEND_EMAIL" → "gmail send email". */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/^(os|mcp)\./, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._\-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? "a tool" : words;
}

function patchTargets(patch: string): string[] {
  const out: string[] = [];
  for (const l of patch.split(/\r?\n/)) {
    if (!l.startsWith("+++ ")) continue;
    let t = (l.slice(4).split("\t")[0] ?? "").trim();
    if (t === "" || t === "/dev/null") continue;
    if (t.startsWith("b/")) t = t.slice(2);
    out.push(t);
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// The table

const P = (verb: Verb, rest = "", ranAnyway?: boolean): Phrase => ({ verb, rest: rest ? ` ${rest}` : "", ...(ranAnyway ? { ranAnyway } : {}) });

const FIXED: Readonly<Record<string, Phrase>> = {
  "os.fs.restore": P(V.restored, "files"),
  "os.fs.locate_project": P(V.found, "the project"),
  "os.proc.list": P(V.listed, "processes"),
  "os.window.list": P(V.listed, "windows"),
  "os.clipboard.read": P(V.read, "the clipboard"),
  "os.clipboard.write": P(V.copied, "to the clipboard"),
  "os.notify": P(V.sent, "a notification"),
  "os.email.inbox": P(V.checked, "email"),
  "browser.click": P(V.clicked, "on the page"),
  "browser.type": P(V.typed, "on the page"),
  "browser.scroll": P(V.scrolled, "the page"),
  "browser.read_aria": P(V.read, "the page"),
  "browser.tabs": P(V.used, "browser tabs"),
  "tasks.list": P(V.listed, "tasks"),
  "tasks.show": P(V.lookedAt, "a task"),
  "tasks.cancel": P(V.cancelled, "a task"),
  "verify.run": P(V.ran, "a check"),
  "verify.syntax": P(V.checked, "the syntax"),
  "video.generate": P(V.generated, "a video"),
  "canvas.render": P(V.created, "a canvas"),
  "github.whoami": P(V.checked, "the GitHub account"),
  "github.issue.list": P(V.listed, "GitHub issues"),
  "github.pr.list": P(V.listed, "pull requests"),
  "github.issue.create": P(V.created, "a GitHub issue"),
  "github.issue.comment": P(V.commented, "on a GitHub issue"),
  "github.pr.create": P(V.created, "a pull request"),
  fusion_worker: P(V.ran, "a worker"),
};

const WEB_SEARCH = new Set(["os.web.search", "browser.search", "web.search", "web", "web_search_exa"]);

function phraseFor(name: string, a: Record<string, unknown>): Phrase {
  switch (name) {
    case "os.fs.read":
    case "os.fs.read_document":
      return P(V.read, fileObject(a, "a file"));
    case "os.fs.write":
      return P(a.mode === "append" ? V.addedTo : V.wrote, fileObject(a, "a file"));
    case "os.fs.edit":
      return P(V.edited, fileObject(a, "a file"));
    case "os.fs.patch": {
      // An inline patch names its files in `+++ b/<path>` headers.
      const targets = typeof a.patch === "string" && !pathsOf(a).first ? patchTargets(a.patch) : [];
      return P(V.edited, targets.length > 0 ? fileObject({ paths: targets }, "a file") : fileObject(a, "a file"));
    }
    case "os.fs.list": {
      const p = str(a.path);
      return P(V.listed, p ? `files in ${shortPath(p)}` : "files");
    }
    case "os.fs.glob": {
      const pat = str(a.pattern);
      return P(V.lookedFor, pat ? clip(pat, MAX_QUOTE) : "files");
    }
    case "os.fs.grep": {
      const pat = str(a.pattern) ?? str(a.query);
      return P(V.searched, pat ? `files for ${quote(pat)}` : "in files");
    }
    case "os.fs.move": {
      const moves = Array.isArray(a.moves) ? a.moves.length : 0;
      const from = str(a.from);
      const to = str(a.to);
      if (from && to) return P(V.moved, `${shortPath(from)} to ${shortPath(to)}`);
      return P(V.moved, moves > 1 ? plural(moves, "file") : "a file");
    }
    case "os.fs.trash":
      return P(V.moved, `${fileObject(a, "files")} to the Trash`);
    case "os.fs.diff": {
      const left = str(a.aPath);
      const right = str(a.bPath);
      if (left && right) return P(V.compared, `${shortPath(left)} and ${shortPath(right)}`);
      return P(V.compared, fileObject(a, "files"));
    }
    case "os.fs.hash":
      return P(V.checked, fileObject(a, "a file"));
    case "os.fs.watch":
      return P(V.watched, fileObject(a, "files"));
    case "os.fs.archive.list":
      return P(V.listed, `the archive ${fileObject(a, "")}`.trim());
    case "os.fs.archive.extract":
      return P(V.extracted, fileObject(a, "an archive"));
    case "os.fs.archive.read_entry": {
      const entry = str(a.entry);
      return P(V.read, entry ? shortPath(entry) : `from ${fileObject(a, "an archive")}`);
    }
    case "os.shell.run": {
      const cmd = commandText(a);
      return P(V.ran, cmd ?? "a command", true);
    }
    case "os.proc.kill": {
      const pid = str(a.pid);
      return P(V.stopped, pid ? `process ${pid}` : "a process");
    }
    case "os.window.focus": {
      const app = str(a.app) ?? str(a.title) ?? str(a.name);
      return P(V.focused, app ? clip(app, 40) : "a window");
    }
    case "os.web.fetch":
    case "browser.navigate": {
      const u = str(a.url);
      return P(V.opened, u ? host(u) : "a web page");
    }
    case "os.http.request": {
      const u = str(a.url);
      return P(V.called, u ? host(u) : "a web service");
    }
    case "os.email.send": {
      const to = str(a.to);
      return P(V.sent, to ? `an email to ${clip(to, 40)}` : "an email");
    }
    case "vision.describe":
      return P(V.lookedAt, fileObject(a, "an image"));
    case "image.generate": {
      const n = typeof a.count === "number" && Number.isInteger(a.count) && a.count > 1 ? a.count : 1;
      const prompt = str(a.prompt);
      return P(V.generated, plural(n, "image") + (prompt ? ` · ${quote(prompt)}` : ""));
    }
    case "fusion.delegate": {
      const n = Array.isArray(a.tasks) ? a.tasks.length : 0;
      return P(V.delegated, n > 0 ? plural(n, "task") : "tasks");
    }
    case "tasks.schedule":
    case "tasks.cron": {
      const title = str(a.title) ?? str(a.name);
      return P(V.scheduled, title ? quote(title) : "a task");
    }
    case "skill.view": {
      const s = str(a.name) ?? str(a.skill);
      return P(V.opened, s ? `the ${clip(s, 40)} skill` : "a skill");
    }
    case "skill.run_script": {
      const s = str(a.script) ?? str(a.name);
      return P(V.ran, s ? `skill script ${shortPath(s)}` : "a skill script", true);
    }
    case "tool.view": {
      const t = str(a.name) ?? str(a.tool);
      return P(V.lookedUp, t ? `the ${humanizeToolName(t)} tool` : "a tool");
    }
  }
  const fixed = FIXED[name];
  if (fixed) return fixed;
  if (WEB_SEARCH.has(name)) {
    const q = str(a.query) ?? str(a.q);
    return P(V.searched, q ? `the web for ${quote(q)}` : "the web");
  }
  if (name.startsWith("os.git.")) {
    return P(V.ran, `git ${humanizeToolName(name.slice("os.git.".length))}`, true);
  }
  if (name.startsWith("browser.")) return P(V.used, `the browser (${humanizeToolName(name.slice(8))})`);
  if (name.startsWith("memory.")) {
    if (/\.(store|set)$/.test(name)) {
      const c = str(a.content) ?? str(a.value);
      const key = str(a.key);
      if (name === "memory.profile.set" && key) return P(V.remembered, `your ${humanizeToolName(key)}`);
      return P(V.remembered, c ? quote(c) : "something");
    }
    if (/\.(recall|list|history|search)$/.test(name)) {
      const q = str(a.query);
      return P(V.recalled, q ? quote(q) : "memories");
    }
    if (/\.(forget|remove|delete)$/.test(name)) return P(V.forgot, "something");
    return P(V.used, "memory");
  }
  if (name.startsWith("mcp.")) {
    // mcp.<server>.<tool>: "Used GitHub: create issue"; Composio's tools
    // are SCREAMING_CASE actions under its own server.
    const [, server = "", ...tool] = name.split(".");
    if (server === "resource" || server === "prompt") return P(V.used, `an MCP ${server}`);
    const label = server === "composio" ? "Composio" : server;
    const what = tool.length > 0 ? humanizeToolName(tool.join(".")) : "";
    return P(V.used, what ? `${label}: ${what}` : label);
  }
  if (name.startsWith("fusion.")) return P(V.used, `Fusion (${humanizeToolName(name.slice(7))})`);
  return P(V.used, humanizeToolName(name));
}

function statusOf(ok: boolean | undefined): ToolCallStatus {
  return ok === true ? "ok" : ok === false ? "error" : "running";
}

/** One call → one line. Never throws. */
export function describeToolCall(input: DescribeToolCallInput): ToolCallDescription {
  const name = typeof input?.name === "string" && input.name.trim() !== "" ? input.name.trim() : "tool";
  const status = statusOf(input?.ok);
  let phrase: Phrase;
  try {
    // As the tool read them: `command` for `cmd`, a move's `{paths, destination}`.
    phrase = phraseFor(name, canonicalArgs(name, argsObject(input?.args)));
  } catch {
    phrase = P(V.used, humanizeToolName(name));
  }
  const [past, ing, base] = phrase.verb;
  let verb: string;
  let line: string;
  if (status === "running") {
    verb = ing;
    line = ing + phrase.rest;
  } else if (status === "ok") {
    verb = past;
    line = past + phrase.rest;
  } else if (phrase.ranAnyway) {
    verb = past;
    line = `${past}${phrase.rest} · failed`;
  } else {
    verb = `Couldn’t ${base}`;
    line = verb + phrase.rest;
  }
  const out: ToolCallDescription = { verb, line: clip(line, MAX_LINE), status };
  if (status === "error" && typeof input?.error === "string" && input.error.trim() !== "") {
    const first = input.error.trim().split("\n")[0] ?? "";
    if (first !== "") out.detail = clip(first, MAX_DETAIL);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregate: "Read 3 files, ran 2 commands"

type Bucket = "read" | "search" | "edit" | "command" | "web" | "page" | "memory" | "other";

function bucketOf(name: string): Bucket {
  if (/^os\.fs\.(read|read_document|archive\.read_entry)$/.test(name) || name === "vision.describe") return "read";
  if (/^os\.fs\.(list|glob|grep|archive\.list)$/.test(name)) return "search";
  if (/^os\.fs\.(write|edit|patch|move|trash|restore|archive\.extract)$/.test(name)) return "edit";
  if (name === "os.shell.run" || name.startsWith("os.git.") || name === "skill.run_script" || name === "verify.run") return "command";
  if (WEB_SEARCH.has(name)) return "web";
  if (name === "os.web.fetch" || name === "browser.navigate" || name === "os.http.request") return "page";
  if (name.startsWith("memory.")) return "memory";
  return "other";
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/**
 * A run of calls as one line, in the order each kind first appeared:
 * "Read 3 files, ran 2 commands, searched the web twice". Failed calls
 * still count (they were attempted); `""` for an empty list.
 */
export function describeToolCalls(list: readonly DescribeToolCallInput[]): string {
  const counts = new Map<Bucket, number>();
  for (const c of list ?? []) {
    const name = typeof c?.name === "string" ? c.name : "";
    if (name === "" || name === "reply" || name === "finish") continue;
    const b = bucketOf(name);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [b, n] of counts) {
    switch (b) {
      case "read":
        parts.push(`read ${plural(n, "file")}`);
        break;
      case "search":
        parts.push(`ran ${plural(n, "search", "searches")}`);
        break;
      case "edit":
        parts.push(`edited ${plural(n, "file")}`);
        break;
      case "command":
        parts.push(`ran ${plural(n, "command")}`);
        break;
      case "web":
        parts.push(`searched the web ${times(n)}`);
        break;
      case "page":
        parts.push(`opened ${plural(n, "page")}`);
        break;
      case "memory":
        parts.push(`used memory ${times(n)}`);
        break;
      case "other":
        parts.push(`used ${plural(n, "other tool")}`);
        break;
    }
  }
  if (parts.length === 0) return "";
  // "used 2 other tools" reads oddly alone: no "other" without a sibling.
  if (parts.length === 1 && counts.has("other")) parts[0] = parts[0]!.replace(" other tool", " tool");
  return capitalize(parts.join(", "));
}
