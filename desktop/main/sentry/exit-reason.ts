/**
 * ATO-763 — why the agent exited, as tags with no text in them.
 *
 * The agent's exit code is almost always 1, so an AgentExited report could
 * not tell running out of memory from a busy port or a broken database. Its
 * last error lines are in main (main.ts AGENT_SAID), but they can hold the
 * person's own words, so they never go into a report. This reads them and
 * answers ONE word from a closed list; the lines stay here.
 *
 * Pure: no Electron, no fs. The unit test drives it on made-up lines.
 */

export const LAST_ERROR_CATEGORIES = [
  "oom", "port_in_use", "econnrefused", "sqlite", "telegram_conflict", "permission", "missing_file",
  // ATO-1285: most 0.0.7 exits were "other" or "none"; the start-up failures seen in agent.log files.
  "native_module", "file_locked", "config_invalid", "network", "disk_full", "node_runtime", "uncaught",
  "none", "other",
] as const;
export type LastErrorCategory = (typeof LAST_ERROR_CATEGORIES)[number];

/** How many of the newest lines are read: the agent's last words, not the whole session. */
export const LAST_LINES = 12;

/** One line's category, or null when it names none of them. Order matters: the more telling cause first. */
function categoryOf(line: string): Exclude<LastErrorCategory, "none" | "other" | "uncaught"> | null {
  if (/out of memory|ENOMEM|heap limit|allocation failed/i.test(line)) return "oom";
  if (/EADDRINUSE|address already in use/i.test(line)) return "port_in_use";
  if (/terminated by other getUpdates|telegram\b.*\b(409|conflict)\b/i.test(line)) return "telegram_conflict";
  // ATO-1285: a native addon (better-sqlite3, the speech helper) that does not load on this machine.
  // Before sqlite: /sqlite/ also matches the addon's file name, better_sqlite3.node.
  if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node|not a valid Win32 application|specified module could not be found|invalid ELF header|\.node\b.*(cannot open|failed)/i.test(line)) return "native_module";
  if (/SQLITE_|sqlite|database disk image is malformed|database is locked/i.test(line)) return "sqlite";
  if (/EACCES|EPERM|permission denied|operation not permitted/i.test(line)) return "permission";
  if (/ENOENT|no such file or directory|cannot find module/i.test(line)) return "missing_file";
  if (/ECONNREFUSED/i.test(line)) return "econnrefused";
  if (/EBUSY|resource busy or locked|being used by another process/i.test(line)) return "file_locked";
  if (/ENOSPC|no space left on device|disk is full/i.test(line)) return "disk_full";
  if (/invalid config|config(uration)? (is )?invalid|could not (read|parse) (the )?config|Unexpected token .* in JSON|JSON\.parse|SyntaxError: .*JSON|YAMLException|ZodError/i.test(line)) return "config_invalid";
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ENETUNREACH|getaddrinfo|certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/i.test(line)) return "network";
  if (/ERR_REQUIRE_ESM|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED|requires Node(\.js)? |Node\.js v\d+.* is not supported|SyntaxError: Unexpected token/i.test(line)) return "node_runtime";
  return null;
}

/**
 * ATO-1285: a crash that named no cause above — an uncaught exception, a
 * failed serve, or a bare stack trace. Checked only after every line was
 * read for a telling cause, since a trace's frames come after its message.
 */
function looksLikeCrash(line: string): boolean {
  return /uncaught|unhandled (promise )?rejection|serve failed:|^\S*\s*at .+:\d+(:\d+)?\)?\s*$/i.test(line);
}

/**
 * A Node / system error code in a line: `ENOENT`, `ERR_DLOPEN_FAILED`, `SQLITE_BUSY`. Codes only, never text around them.
 * The errno family is a fixed list: any upper-case word starting with E (EXAMPLE, EMPLOYEE) is not a code.
 */
const ERRNO_CODES = [
  "E2BIG", "EACCES", "EADDRINUSE", "EADDRNOTAVAIL", "EAGAIN", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME",
  "EBADF", "EBUSY", "ECANCELED", "ECHILD", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EDQUOT", "EEXIST",
  "EFBIG", "EHOSTDOWN", "EHOSTUNREACH", "EILSEQ", "EINTR", "EINVAL", "EIO", "EISDIR", "ELOOP", "EMFILE",
  "ENAMETOOLONG", "ENETDOWN", "ENETRESET", "ENETUNREACH", "ENFILE", "ENOBUFS", "ENODEV", "ENOENT", "ENOEXEC",
  "ENOMEM", "ENOSPC", "ENOSYS", "ENOTCONN", "ENOTDIR", "ENOTEMPTY", "ENOTFOUND", "ENOTSOCK", "ENOTSUP", "ENXIO",
  "EPERM", "EPIPE", "EPROTO", "ERANGE", "EROFS", "ESHUTDOWN", "ESPIPE", "ESRCH", "ETIMEDOUT", "ETXTBSY", "EXDEV",
];
const ERR_CODE_RE = new RegExp(`\\b(${ERRNO_CODES.join("|")}|ERR_[A-Z0-9_]{3,48}|SQLITE_[A-Z_]{2,32})\\b`, "g");
/** An error class name: `TypeError`, `SqliteError`, `ZodError`. */
const ERR_TYPE_RE = /\b([A-Z][A-Za-z0-9]{1,48}(?:Error|Exception))\b/g;
/** A stack frame's location: `at fn (<where>:162:7)` or `at <where>:162:7`. */
const FRAME_RE = /^\W*at\s+(?:.*?\()?(.+?):(\d{1,6})(?::\d+)?\)?\s*$/;
/**
 * The agent the app runs is one bundle (scripts/bundle-sea.ts: cli.mjs in a
 * Node single-executable named atomic-agent), so its frames name that file.
 * Only these, Node's own modules and packages under node_modules get a name
 * in a report: a frame in a person's own code (a skill, an MCP server, a
 * script of theirs) is skipped, its file name never read out.
 */
const OUR_FILES = new Set(["cli.mjs", "cli.js", "atomic-agent", "atomic-agent.exe", "atag", "atag.exe"]);
function frameFile(line: string): { file: string | null; frame: boolean } {
  const m = FRAME_RE.exec(line);
  if (!m) return { file: null, frame: false };
  const where = m[1]!.replace(/^file:\/\//, "");
  const at = m[2]!;
  const node = /^node:([\w/]{1,40})$/.exec(where);
  if (node) return { file: `node:${node[1]!.replace(/\//g, ".")}:${at}`, frame: true };
  const base = where.split(/[\\/]/).pop() ?? "";
  if (!/^[\w.@-]{1,80}$/.test(base)) return { file: null, frame: true };
  if (OUR_FILES.has(base) || /[\\/]node_modules[\\/]/.test(where)) return { file: `${base}:${at}`, frame: true };
  return { file: null, frame: true };
}

/** The newest match of `re` across `lines`, newest line first. */
function newestMatch(lines: readonly string[], re: RegExp, pick: (m: RegExpExecArray) => string): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    let last: string | null = null;
    re.lastIndex = 0;
    if (re.global) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) last = pick(m);
    } else {
      const m = re.exec(line);
      if (m) last = pick(m);
    }
    if (last) return last;
  }
  return null;
}

/**
 * ATO-1285 — what the agent's last lines say went wrong, as tag-shaped words
 * only: an error code from a fixed list, an error class name and the file
 * of the first stack frame in our own bundle (or Node, or a package). No
 * message text, no path, no file of a person's own, no number other than a
 * line in that file, so nothing a person typed or a folder name can get
 * into a report. Null fields are left out of the report.
 */
export function lastErrorFacts(lines: readonly string[]): { err_code: string | null; err_type: string | null; err_file: string | null } {
  const recent = lines.slice(Math.max(0, lines.length - LAST_LINES)).filter((l) => typeof l === "string" && l.trim());
  const code = newestMatch(recent, ERR_CODE_RE, (m) => m[1]!);
  const type = newestMatch(recent, ERR_TYPE_RE, (m) => m[1]!);
  // The first frame of ours printed is nearest where it was thrown: read oldest first.
  // A trace with frames only in someone else's code says so, without a name.
  let file: string | null = null;
  let frames = false;
  for (const line of recent) {
    const f = frameFile(line);
    frames ||= f.frame;
    if (f.file) { file = f.file; break; }
  }
  return { err_code: code, err_type: type, err_file: file ?? (frames ? "outside_app" : null) };
}

/** ATO-1285: how many lines the agent wrote before it exited, as a bucket. "0" tells a silent death from a filtered one. */
export function linesBucket(n: number | null | undefined): "0" | "1_5" | "6_50" | "gt_50" | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  if (n === 0) return "0";
  if (n <= 5) return "1_5";
  if (n <= 50) return "6_50";
  return "gt_50";
}

/** ATO-1285: a category in plain words, for the card the window shows once the restarts ran out. Null for none / other. */
export function lastErrorSentence(category: LastErrorCategory): string | null {
  switch (category) {
    case "oom": return "The computer ran out of memory.";
    case "port_in_use": return "Another program is using the agent's network port.";
    case "econnrefused": return "The agent could not reach a service it needs.";
    case "sqlite": return "The agent's database could not be opened.";
    case "telegram_conflict": return "Another copy of the agent is connected to the same Telegram bot.";
    case "permission": return "The agent was not allowed to open a file or folder it needs.";
    case "missing_file": return "A file the agent needs is missing.";
    case "native_module": return "Part of the agent does not load on this computer.";
    case "file_locked": return "A file the agent needs is locked by another program (often antivirus or a second copy of the app).";
    case "config_invalid": return "The agent's settings file could not be read.";
    case "network": return "A network error stopped the agent while it started.";
    case "disk_full": return "The disk is full.";
    case "node_runtime": return "The agent's runtime does not match this install.";
    case "uncaught": return "The agent hit an internal error.";
    default: return null;
  }
}

/**
 * The category of the agent's last error: the newest of its last LAST_LINES
 * lines that names one; `other` when it said something none of them match;
 * `none` when it said nothing at all (a kill from outside, say).
 */
export function lastErrorCategory(lines: readonly string[]): LastErrorCategory {
  const recent = lines.slice(Math.max(0, lines.length - LAST_LINES)).filter((l) => typeof l === "string" && l.trim());
  if (recent.length === 0) return "none";
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = categoryOf(recent[i]!);
    if (c) return c;
  }
  if (recent.some(looksLikeCrash)) return "uncaught";
  return "other";
}

/** How long the agent had run, as a bucket (never the figure). Null when unknown. */
export function uptimeBucket(ms: number | null | undefined): "lt_10s" | "lt_1m" | "lt_10m" | "lt_1h" | "gte_1h" | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_1m";
  if (ms < 600_000) return "lt_10m";
  if (ms < 3_600_000) return "lt_1h";
  return "gte_1h";
}

/**
 * ATO-424 / ATO-761: the machine's free memory when the agent exited, as a
 * bucket. Sentry showed Windows exits with 0xC000009A (out of system
 * resources) beside Electron's own processes crashing; this says whether
 * the machine was short of memory at that moment. Null when unknown.
 */
export function freeMemoryBucket(freeBytes: number | null | undefined): "lt_512m" | "lt_1g" | "lt_2g" | "lt_4g" | "gte_4g" | null {
  if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0) return null;
  const mb = freeBytes / 1_048_576;
  if (mb < 512) return "lt_512m";
  if (mb < 1024) return "lt_1g";
  if (mb < 2048) return "lt_2g";
  if (mb < 4096) return "lt_4g";
  return "gte_4g";
}

/** Windows NTSTATUS codes an exit code may carry, as a word (0xC000009A is 3221225626). Null for any other code. */
export function windowsExitStatus(code: number | null | undefined): "insufficient_resources" | "no_memory" | "stack_overflow" | "killed_from_outside" | "access_violation" | null {
  switch (code) {
    case 0xc000009a: return "insufficient_resources";
    case 0xc0000017: return "no_memory";
    case 0xc00000fd: return "stack_overflow";
    case 0x40010004: return "killed_from_outside";
    case 0xc0000005: return "access_violation";
    default: return null;
  }
}

/**
 * ATO-1111: serve's exit code when its memory guard ended it cleanly
 * (src/cli/serve-memory-guard.ts MEMORY_GUARD_EXIT_CODE; the two must agree).
 */
export const AGENT_MEMORY_GUARD_EXIT_CODE = 86;

/**
 * The agent's exit code as one readable word for the `exit_status` tag: a
 * Windows NTSTATUS (windowsExitStatus) or the memory guard's own clean exit.
 * Null for any other code.
 */
export function agentExitStatus(code: number | null | undefined): ReturnType<typeof windowsExitStatus> | "memory_guard" {
  if (code === AGENT_MEMORY_GUARD_EXIT_CODE) return "memory_guard";
  return windowsExitStatus(code);
}

/** The agent's last sampled resident memory, as a bucket (never the figure). Null when unknown. */
export function agentRssBucket(rssMb: number | null | undefined): "lt_512m" | "lt_1g" | "lt_2g" | "lt_4g" | "lt_8g" | "gte_8g" | null {
  if (typeof rssMb !== "number" || !Number.isFinite(rssMb) || rssMb < 0) return null;
  if (rssMb < 512) return "lt_512m";
  if (rssMb < 1024) return "lt_1g";
  if (rssMb < 2048) return "lt_2g";
  if (rssMb < 4096) return "lt_4g";
  if (rssMb < 8192) return "lt_8g";
  return "gte_8g";
}

/**
 * A share (part of whole) as a bucket: the agent's heap of its V8 ceiling,
 * or its RSS of the machine's memory. With agentRssBucket this tells a
 * growing agent (high heap share, big RSS) from a machine that is simply
 * small (modest RSS, high share of a small total). Null when unknown.
 */
export function shareBucket(part: number | null | undefined, whole: number | null | undefined): "lt_25" | "lt_50" | "lt_75" | "lt_90" | "gte_90" | null {
  if (typeof part !== "number" || typeof whole !== "number" || !Number.isFinite(part) || !Number.isFinite(whole) || part < 0 || whole <= 0) return null;
  const pct = (part / whole) * 100;
  if (pct < 25) return "lt_25";
  if (pct < 50) return "lt_50";
  if (pct < 75) return "lt_75";
  if (pct < 90) return "lt_90";
  return "gte_90";
}
