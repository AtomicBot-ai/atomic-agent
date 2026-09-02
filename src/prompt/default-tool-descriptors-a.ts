import type { ToolDescriptor } from "./stable-prefix.js";

/** First half of `DEFAULT_TOOL_DESCRIPTORS` (order is load-bearing). */
export const DEFAULT_TOOL_DESCRIPTORS_A: readonly ToolDescriptor[] = [
  {
    name: "browser.navigate",
    summary:
      "Open a URL in the controlled browser tab. LAST RESORT — do NOT use this to read a page (use os.web.fetch) or to search (use os.web.search). Allowed ONLY when the user explicitly asks for the browser, or the page truly needs JS/login/clicks that os.web.fetch cannot deliver.",
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
    summary:
      "Web search in the live browser (opens the SERP, refreshes the world snapshot). LAST RESORT — to search the web use os.web.search instead. Allowed ONLY when the user explicitly asks to search via the browser, or you must then click/read the live results.",
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
    summary:
      "Read a UTF-8 file — the default for source code and text files; use offset/limit for ranges, lineNumbers for 'LINE|'.",
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
    summary:
      "Non-recursive directory listing (default maxEntries=200). Header shows full totals—when matched/total is much larger than shown, narrow with extensions (e.g. [\"pdf\"]), pattern (glob-like *foo*), or sort (name|size|mtime); recurse with os.fs.glob. Do not treat the visible slice as the whole tree.",
    argsSchema:
      "{ path: string, pattern?: string, kind?: \"file\" | \"dir\", extensions?: string[], sort?: \"name\" | \"size\" | \"mtime\", maxEntries?: number }",
  },
  {
    name: "os.fs.glob",
    summary:
      "Recursive path match under cwd or path (prefer cwd; default: session working directory). For large trees use tight patterns (e.g. **/*CV*.pdf, **/*resume*.pdf), sensible limit, sortByMtime when freshness matters; pass nocase=true to match regardless of case (covers CV/cv/Cv in one pass). Walk traverses the whole tree (minus ignore) before sorting and slicing to limit, so limit reliably gives you the best matches. Default ignore covers common caches (.cache, Library, node_modules, .cargo, __pycache__, etc.)—override with explicit ignore if you need to look there.",
    argsSchema:
      "{ pattern: string | string[], cwd?: string, path?: string, ignore?: string[], absolute?: boolean, limit?: number, sortByMtime?: boolean, nocase?: boolean }",
  },
  {
    name: "os.fs.locate_project",
    summary:
      "Resolve a project directory from a short folder-name segment the user mentioned (raylib finds .../_raylib). Pass only that segment or a pasted absolute path as name, never the whole sentence. Searches the session cwd + ancestors, recent session dirs, and configured projects.roots (one level; never a whole-disk scan). Single match: use the returned path. Multiple: ask the user to pick. None: ask for the full path.",
    argsSchema: "{ name: string, limit?: number }",
    examples: ['{"name":"raylib"}', '{"name":"tasks-board"}'],
  },
  {
    name: "os.fs.grep",
    summary:
      "Regex ripgrep for text search (content, files_with_matches, count). Best on source/text trees. Avoid tree-wide runs with glob *.pdf (or similar) over huge dirs—slow, binary-heavy, often flaky; prefer os.fs.glob by filename + os.fs.read_document on a small candidate set.",
    argsSchema:
      "{ pattern: string, path?: string, glob?: string | string[], type?: string, caseInsensitive?: boolean, multiline?: boolean, outputMode?: 'content' | 'files_with_matches' | 'count', contextBefore?: number, contextAfter?: number, contextAround?: number, headLimit?: number, offset?: number, showLineNumbers?: boolean, timeoutMs?: number }",
  },
  {
    name: "os.fs.edit",
    summary: "Surgical string replace; oldString must be unique unless replaceAll (may require approval).",
    argsSchema: "{ path: string, oldString: string, newString: string, replaceAll?: boolean }",
  },
  {
    // Models reach for read_document on `.py` / `.ts` source files, hit the
    // unsupported-extension error and burn a step guessing `format`. The
    // summary therefore names the sibling tool explicitly: source and text
    // go to os.fs.read, this one is for document extraction only.
    name: "os.fs.read_document",
    summary:
      "Extract plain text from documents — PDF, Office, ODF, RTF (markers in output). NOT for source code or text files: use os.fs.read. Read-only.",
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
    summary:
      "Raw HTTP GET/POST via curl for APIs/JSON; returns the body verbatim (no HTML extraction). Host allowlist + approval from config.http. To read a web page, use os.web.fetch.",
    argsSchema:
      "{ url: string, method?: 'GET' | 'POST', headers?: Record<string, string>, body?: string | object, timeoutMs?: number, followRedirects?: boolean }",
  },
  {
    name: "os.web.search",
    summary:
      "Search the web via the configured provider (Exa by default with a DuckDuckGo fallback; SearXNG/Brave configurable; Exa/Brave can use env API keys). Returns compact title/url/snippet results. Use os.web.fetch to read a chosen result.",
    argsSchema: `{ query: string, maxResults?: number }`,
    examples: [
      '{"query":"atomic agent local operator runtime","maxResults":5}',
      '{"query":"latest llama.cpp server grammar cache_prompt slot_id"}',
    ],
  },
  {
    name: "os.web.fetch",
    summary:
      "Read a web page as readable markdown/text (cf-markdown → Readability → basic). GET only, no JS, no auth; SSRF-guarded; read-only. For raw API/JSON or POST, use os.http.request.",
    argsSchema: `{ url: string, extractMode?: "markdown" | "text", maxChars?: number, timeoutMs?: number }`,
    examples: [
      '{"url":"https://example.com/article"}',
      '{"url":"https://docs.example.com/guide","extractMode":"text","maxChars":20000}',
    ],
  },
];
