import type { ToolDescriptor } from "./stable-prefix.js";

/**
 * JSON-Schema-ish descriptors for every tool registered by default.
 * We keep them as plain strings (compact JSON) instead of full JSON Schema
 * trees so the stable prefix stays readable and cheap to tokenise. The
 * descriptors mirror the validation performed at runtime inside each tool
 * — they are the contract for the LLM.
 */
export const DEFAULT_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  {
    name: "browser.navigate",
    summary: "Open a URL in the controlled browser tab.",
    argsSchema: '{"url": "string"}',
  },
  {
    name: "browser.click",
    summary: "Click on a snapshot element by its aria-ref identifier.",
    argsSchema: '{"ref": "string (from latest read_aria)"}',
  },
  {
    name: "browser.type",
    summary: "Type text into a snapshot element; optionally press Enter.",
    argsSchema:
      '{"ref": "string", "text": "string", "pressEnter": "bool (optional)"}',
  },
  {
    name: "browser.read_aria",
    summary: "Capture the current page as a compact ARIA text snapshot.",
    argsSchema: "{}",
  },
  {
    name: "browser.search",
    summary: "Run a high-level web search and return the result page.",
    argsSchema: '{"query": "string", "engine": "string (optional)"}',
  },
  {
    name: "browser.tabs",
    summary: "Manage browser tabs.",
    argsSchema:
      '{"action": "list|switch|close|new", "index": "number (optional)", "url": "string (optional)"}',
  },
  {
    name: "browser.scroll",
    summary:
      "Scroll the active page up/down/top/bottom. Does not refresh ARIA; call browser.read_aria after to observe new content.",
    argsSchema:
      '{"direction": "up|down|top|bottom", "amount": "page|half|number (optional)"}',
  },
  {
    name: "os.shell.run",
    summary: "Run an OS command in the working directory (requires approval).",
    argsSchema:
      '{"cmd": "string", "args": "string[]", "cwd": "string (optional)", "timeoutMs": "number (optional)"}',
  },
  {
    name: "os.fs.read",
    summary:
      "Read a UTF-8 text file. Use `offset`/`limit` for line-range reads and `lineNumbers` to prepend 'LINE_NUMBER|' prefixes.",
    argsSchema:
      '{"path": "string", "maxBytes": "number (optional)", "offset": "number (optional, 1-indexed; negative counts from end)", "limit": "number (optional)", "lineNumbers": "bool (optional)"}',
  },
  {
    name: "os.fs.write",
    summary: "Write content to a file (requires approval).",
    argsSchema:
      '{"path": "string", "content": "string", "mode": "replace|append (optional)"}',
  },
  {
    name: "os.fs.list",
    summary: "List entries in a directory (non-recursive).",
    argsSchema: '{"path": "string", "maxEntries": "number (optional)"}',
  },
  {
    name: "os.fs.glob",
    summary:
      "Recursively find files matching glob patterns (`*`, `**`, `?`, `{a,b}`). Read-only.",
    argsSchema:
      '{"pattern": "string | string[]", "cwd": "string (optional)", "ignore": "string[] (optional)", "absolute": "bool (optional)", "limit": "number (optional)", "sortByMtime": "bool (optional)"}',
  },
  {
    name: "os.fs.grep",
    summary:
      "Fast regex search via bundled ripgrep. Output modes: content, files_with_matches, count. Read-only.",
    argsSchema:
      '{"pattern": "string", "path": "string (optional)", "glob": "string | string[] (optional)", "type": "string (optional)", "caseInsensitive": "bool (optional)", "multiline": "bool (optional)", "outputMode": "content|files_with_matches|count (optional)", "contextBefore": "number (optional)", "contextAfter": "number (optional)", "contextAround": "number (optional)", "headLimit": "number (optional)", "offset": "number (optional)", "showLineNumbers": "bool (optional)"}',
  },
  {
    name: "os.fs.edit",
    summary:
      "Surgical string replacement in a file. `oldString` must be unique unless `replaceAll=true` (requires approval).",
    argsSchema:
      '{"path": "string", "oldString": "string", "newString": "string", "replaceAll": "bool (optional)"}',
  },
  {
    name: "os.fs.read_document",
    summary:
      "Extract plain text (with light structure markers) from PDF, DOCX, DOC (legacy), XLSX, RTF, ODT, PPTX, and text files. Auto-detects format from extension. Output uses `--- page N ---` / `## Sheet: <name>` markers; details carry pageCount, sheetCount, warnings. Read-only.",
    argsSchema:
      '{"path": "string", "format": "string (optional)", "maxBytes": "number (optional, default 5MB)", "maxPages": "number (optional, default 50)", "pagesFrom": "number (optional)", "pagesTo": "number (optional)", "sheets": "(string|number)[] (optional, xlsx only)", "pageSeparators": "bool (optional, default true)", "includeTables": "bool (optional, default true)"}',
  },
  {
    name: "os.fs.archive.list",
    summary:
      "List entries inside an archive (zip, tar, tar.gz/tgz, gz) without extracting. Returns a compact listing plus a structured `entries` array. Read-only.",
    argsSchema:
      '{"path": "string", "format": "zip|tar|tar.gz|gz (optional override)"}',
  },
  {
    name: "os.fs.archive.read_entry",
    summary:
      "Read a single entry from an archive without writing to disk. Default encoding is UTF-8 with automatic base64 fallback when NUL bytes are detected.",
    argsSchema:
      '{"path": "string", "entry": "string", "as": "utf8|base64 (optional)", "maxBytes": "number (optional)", "format": "zip|tar|tar.gz|gz (optional)"}',
  },
  {
    name: "os.fs.archive.extract",
    summary:
      "Extract an archive into destDir (requires approval). Zip-slip, symlink-escape, and decompression-bomb protections are always on. `include` filters entries by path prefix; `limits` overrides the default 100MB / 10MB per entry / 10k entry caps.",
    argsSchema:
      '{"path": "string", "destDir": "string", "overwrite": "bool (optional)", "followSymlinks": "bool (optional)", "include": "string[] (optional prefixes)", "limits": "{maxTotalBytes?, maxEntryBytes?, maxEntries?} (optional)", "format": "zip|tar|tar.gz|gz (optional)"}',
  },
  {
    name: "os.fs.hash",
    summary:
      "Compute a cryptographic digest of a file (md5 | sha1 | sha256 | sha512). Streams the file — safe for multi-GB inputs. Read-only.",
    argsSchema:
      '{"path": "string", "algorithm": "md5|sha1|sha256|sha512 (optional, default sha256)", "encoding": "hex|base64 (optional, default hex)"}',
  },
  {
    name: "os.fs.diff",
    summary:
      "Generate a git-style unified diff between two files (aPath vs bPath) or two inline strings (aText vs bText). Read-only.",
    argsSchema:
      '{"aPath": "string (optional)", "aText": "string (optional)", "aLabel": "string (optional)", "bPath": "string (optional)", "bText": "string (optional)", "bLabel": "string (optional)", "context": "number (optional, default 3)", "ignoreWhitespace": "bool (optional)"}',
  },
  {
    name: "os.fs.patch",
    summary:
      "Apply a unified-diff patch to files. `apply=false` (default) is a DRY-RUN preview; `apply=true` writes the result and requires approval. Refuses to partially apply when any hunk fails to land.",
    argsSchema:
      '{"patch": "string (optional inline patch)", "patchPath": "string (optional path to .patch)", "apply": "bool (optional, default false)", "rootDir": "string (optional, default working dir)", "fuzzFactor": "number (optional, default 0)", "stripComponents": "number (optional, default 1 — strips a/ b/ prefixes)"}',
  },
  {
    name: "os.fs.watch",
    summary:
      "Watch a file or directory for filesystem events for up to timeoutMs (default 5000, cap 60000). Returns a list of {kind, path, timestamp} entries. Read-only, one-shot.",
    argsSchema:
      '{"path": "string", "timeoutMs": "number (optional, default 5000, max 60000)", "recursive": "bool (optional, default false)", "events": "array of add|change|unlink|addDir|unlinkDir (optional)", "ignoreInitial": "bool (optional, default true)", "maxEvents": "number (optional)", "stopAfterFirst": "bool (optional)"}',
  },
  {
    name: "os.git.status",
    summary:
      "Show working-tree status (porcelain). Returns a structured list of changed/untracked paths plus the current branch. Read-only.",
    argsSchema: '{"repo": "string (optional)"}',
  },
  {
    name: "os.git.log",
    summary:
      "Show commit history with structured entries (hash, author, date, subject, body).",
    argsSchema:
      '{"repo": "string (optional)", "limit": "number (optional, default 20)", "revisionRange": "string (optional, e.g. main..HEAD)", "path": "string (optional path filter)"}',
  },
  {
    name: "os.git.diff",
    summary:
      "Show a unified diff between working tree, index, or arbitrary revisions.",
    argsSchema:
      '{"repo": "string (optional)", "revisionRange": "string (optional)", "staged": "bool (optional)", "paths": "string[] (optional)", "context": "number (optional, default 3)"}',
  },
  {
    name: "os.git.show",
    summary:
      "Show a commit: metadata + numstat + patch (suppress patch with patch=false).",
    argsSchema:
      '{"repo": "string (optional)", "revision": "string (optional, default HEAD)", "patch": "bool (optional, default true)"}',
  },
  {
    name: "os.git.blame",
    summary:
      "Per-line authorship for a file. Optional startLine/endLine range.",
    argsSchema:
      '{"repo": "string (optional)", "path": "string", "revision": "string (optional, default HEAD)", "startLine": "number (optional)", "endLine": "number (optional)"}',
  },
  {
    name: "os.git.branch",
    summary:
      "List branches; optionally include remotes or filter by pattern/contains.",
    argsSchema:
      '{"repo": "string (optional)", "includeRemote": "bool (optional)", "contains": "string (optional)", "pattern": "string (optional glob)"}',
  },
  {
    name: "os.proc.list",
    summary:
      "Snapshot of running processes (PID/PPID/user/CPU%/MEM%/command). Read-only.",
    argsSchema:
      '{"filter": "string (optional substring match on command)", "limit": "number (optional, default 500)"}',
  },
  {
    name: "os.proc.kill",
    summary:
      "Send a signal to a process by PID (requires approval). Supported signals: SIGTERM, SIGKILL, SIGINT, SIGHUP.",
    argsSchema:
      '{"pid": "number", "signal": "SIGTERM|SIGKILL|SIGINT|SIGHUP (optional, default SIGTERM)"}',
  },
  {
    name: "os.http.request",
    summary:
      "Make an HTTP GET or POST via the system `curl` binary. Host allowlist and approval policy are enforced via `config.http`. Body can be a string or a JSON-serialisable object (auto Content-Type).",
    argsSchema:
      '{"url": "string", "method": "GET|POST (optional)", "headers": "Record<string,string> (optional)", "body": "string | object (optional, POST only)", "timeoutMs": "number (optional)", "followRedirects": "bool (optional)"}',
  },
  {
    name: "os.clipboard.read",
    summary: "Read the system clipboard as text.",
    argsSchema: "{}",
  },
  {
    name: "os.clipboard.write",
    summary: "Write text to the system clipboard.",
    argsSchema: '{"value": "string"}',
  },
  {
    name: "os.window.list",
    summary: "List visible window titles on the host OS.",
    argsSchema: "{}",
  },
  {
    name: "os.window.focus",
    summary: "Focus a window whose title contains the given substring.",
    argsSchema: '{"title": "string"}',
  },
  {
    name: "os.notify",
    summary: "Show a system notification (title + message).",
    argsSchema:
      '{"title": "string", "message": "string", "sound": "bool (optional)"}',
  },
  {
    name: "skill.view",
    summary:
      "Load the body of an installed skill into the session (progressive loading).",
    argsSchema: '{"name": "string"}',
  },
  {
    name: "skill.run_script",
    summary:
      "Run a script declared in a skill's requires_scripts (requires approval).",
    argsSchema:
      '{"skill": "string", "script": "string", "args": "string[] (optional)", "timeoutMs": "number (optional)"}',
  },
  {
    name: "reply",
    summary:
      "Send the FINAL natural-language answer to the user. Ends the current turn — the session stays open for the next user message. NEVER use `reply` to announce an action you are about to take (e.g. do NOT write 'I will now click X'); emit that action's tool call directly instead. Call only when the task is fully done, it is small-talk, or you need a clarifying question from the user. Keep `text` short: do not paste large file lists or raw tool dumps — summarize counts, show at most a handful of examples, and point to paths or prior tool output instead (long `text` can exceed the completion token budget and break JSON).",
    argsSchema: '{"text": "string"}',
  },
  {
    name: "finish",
    summary:
      "Close the whole session with a final summary. Use only when the user explicitly asks to end the session.",
    argsSchema: '{"summary": "string"}',
  },
];
