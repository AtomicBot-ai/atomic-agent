import type { ToolDescriptor } from "./stable-prefix.js";

/** First half of `DEFAULT_TOOL_DESCRIPTORS` (order is load-bearing). */
export const DEFAULT_TOOL_DESCRIPTORS_A: readonly ToolDescriptor[] = [
  {
    name: "browser.navigate",
    summary: "Open a URL in the controlled browser tab.",
    argsSchema: "{ url: string }",
  },
  {
    name: "browser.click",
    summary: "Click a snapshot element by aria-ref from the latest read.",
    argsSchema: "{ ref: string }",
  },
  {
    name: "browser.type",
    summary: "Type into a snapshot element; optional Enter.",
    argsSchema: "{ ref: string, text: string, pressEnter?: boolean }",
  },
  {
    name: "browser.read_aria",
    summary: "Capture the page as a compact ARIA text snapshot.",
    argsSchema: "{}",
  },
  {
    name: "browser.search",
    summary: "Run a high-level web search; refreshes the world snapshot.",
    argsSchema: "{ query: string, engine?: string }",
  },
  {
    name: "browser.tabs",
    summary: "List, switch, close, or open browser tabs.",
    argsSchema: `{ action: "list" | "switch" | "close" | "new", index?: number, url?: string }`,
  },
  {
    name: "browser.scroll",
    summary: "Scroll the page; does not refresh ARIA — read_aria after if needed.",
    argsSchema: `{ direction: "up" | "down" | "top" | "bottom", amount?: "page" | "half" | number }`,
  },
  {
    name: "os.shell.run",
    summary:
      "Run a shell command in the working directory (may require approval). Not for deleting user files — use os.fs.trash when the user wants paths removed.",
    argsSchema: "{ cmd: string, args: string[], cwd?: string, timeoutMs?: number }",
  },
  {
    name: "os.fs.read",
    summary: "Read a UTF-8 file; use offset/limit for ranges, lineNumbers for 'LINE|'.",
    argsSchema:
      "{ path: string, maxBytes?: number, offset?: number /* 1-based; neg=from end */, limit?: number, lineNumbers?: boolean }",
  },
  {
    name: "os.fs.write",
    summary: "Write or append to a file (may require approval).",
    argsSchema: `{ path: string, content: string, mode?: "replace" | "append" }`,
  },
  {
    name: "os.fs.trash",
    summary:
      "When the user asks to delete, remove, erase, or trash files or directories: move them to the system Trash / Recycle Bin via absolute paths in paths (may require approval). Prefer this over os.shell.run rm.",
    argsSchema: "{ paths: string[] }",
  },
  {
    name: "os.fs.list",
    summary: "List a directory (non-recursive).",
    argsSchema: "{ path: string, maxEntries?: number }",
  },
  {
    name: "os.fs.glob",
    summary:
      "Recursively find paths matching glob patterns. Read-only. Search root is `cwd` or `path` (same meaning; prefer `cwd`; default: session working directory).",
    argsSchema:
      "{ pattern: string | string[], cwd?: string, path?: string, ignore?: string[], absolute?: boolean, limit?: number, sortByMtime?: boolean }",
  },
  {
    name: "os.fs.grep",
    summary: "Regex search via ripgrep (content, files, or count). Read-only.",
    argsSchema:
      "{ pattern: string, path?: string, glob?: string | string[], type?: string, caseInsensitive?: boolean, multiline?: boolean, outputMode?: 'content' | 'files_with_matches' | 'count', contextBefore?: number, contextAfter?: number, contextAround?: number, headLimit?: number, offset?: number, showLineNumbers?: boolean }",
  },
  {
    name: "os.fs.edit",
    summary: "Surgical string replace; oldString must be unique unless replaceAll (may require approval).",
    argsSchema: "{ path: string, oldString: string, newString: string, replaceAll?: boolean }",
  },
  {
    name: "os.fs.read_document",
    summary: "Extract plain text from PDF, Office, ODF, etc. (markers in output). Read-only.",
    argsSchema:
      "{ path: string, format?: string, maxBytes?: number, maxPages?: number, pagesFrom?: number, pagesTo?: number, sheets?: (string | number)[], pageSeparators?: boolean, includeTables?: boolean }",
  },
  {
    name: "os.fs.archive.list",
    summary: "List archive entries (zip, tar, tar.gz, gz) without extracting.",
    argsSchema: "{ path: string, format?: 'zip' | 'tar' | 'tar.gz' | 'gz' }",
    tier: "rare",
  },
  {
    name: "os.fs.archive.read_entry",
    summary: "Read one archive entry without writing to disk. Read-only.",
    argsSchema:
      "{ path: string, entry: string, as?: 'utf8' | 'base64', maxBytes?: number, format?: 'zip' | 'tar' | 'tar.gz' | 'gz' }",
    tier: "rare",
  },
  {
    name: "os.fs.archive.extract",
    summary: "Extract an archive to destDir (guarded; may require approval).",
    argsSchema:
      "{ path: string, destDir: string, overwrite?: boolean, followSymlinks?: boolean, include?: string[], limits?: { maxTotalBytes?: number, maxEntryBytes?: number, maxEntries?: number }, format?: 'zip' | 'tar' | 'tar.gz' | 'gz' }",
    tier: "rare",
  },
  {
    name: "os.fs.hash",
    summary: "File digest (md5, sha1, sha256, sha512). Read-only, streams.",
    argsSchema: `{ path: string, algorithm?: "md5" | "sha1" | "sha256" | "sha512", encoding?: "hex" | "base64" }`,
    tier: "rare",
  },
  {
    name: "os.fs.diff",
    summary: "Unified diff: files and/or inline strings. Read-only.",
    argsSchema:
      "{ aPath?: string, aText?: string, aLabel?: string, bPath?: string, bText?: string, bLabel?: string, context?: number, ignoreWhitespace?: boolean }",
    tier: "rare",
  },
  {
    name: "os.fs.patch",
    summary: "Preview (default) or apply a unified-diff patch (apply=true may require approval).",
    argsSchema:
      "{ patch?: string, patchPath?: string, apply?: boolean, rootDir?: string, fuzzFactor?: number, stripComponents?: number }",
    tier: "rare",
  },
  {
    name: "os.fs.watch",
    summary: "One-shot file/dir watch up to timeoutMs. Read-only.",
    argsSchema:
      "{ path: string, timeoutMs?: number, recursive?: boolean, events?: ('add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir')[], ignoreInitial?: boolean, maxEvents?: number, stopAfterFirst?: boolean }",
    tier: "rare",
  },
  {
    name: "os.git.status",
    summary: "Working tree status (porcelain) and current branch. Read-only.",
    argsSchema: "{ repo?: string }",
  },
  {
    name: "os.git.log",
    summary: "Commit history with structured fields. Read-only.",
    argsSchema: "{ repo?: string, limit?: number, revisionRange?: string, path?: string }",
  },
  {
    name: "os.git.diff",
    summary: "Unified diff (working tree, index, or revisions). Read-only.",
    argsSchema: "{ repo?: string, revisionRange?: string, staged?: boolean, paths?: string[], context?: number }",
  },
  {
    name: "os.git.show",
    summary: "One commit: metadata, numstat, optional patch. Read-only.",
    argsSchema: "{ repo?: string, revision?: string, patch?: boolean }",
    tier: "rare",
  },
  {
    name: "os.git.blame",
    summary: "Per-line authorship for a file. Read-only.",
    argsSchema:
      "{ repo?: string, path: string, revision?: string, startLine?: number, endLine?: number }",
    tier: "rare",
  },
  {
    name: "os.git.branch",
    summary: "List branches; optional remotes, pattern, or contains. Read-only.",
    argsSchema: "{ repo?: string, includeRemote?: boolean, contains?: string, pattern?: string }",
    tier: "rare",
  },
  {
    name: "os.proc.list",
    summary: "List processes (filter, limit). Read-only.",
    argsSchema: "{ filter?: string, limit?: number }",
  },
  {
    name: "os.proc.kill",
    summary: "Send a signal to a PID (may require approval).",
    argsSchema: `{ pid: number, signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" }`,
  },
  {
    name: "os.http.request",
    summary: "HTTP GET/POST via curl; host allowlist and approval from config.http.",
    argsSchema:
      "{ url: string, method?: 'GET' | 'POST', headers?: Record<string, string>, body?: string | object, timeoutMs?: number, followRedirects?: boolean }",
  },
];
