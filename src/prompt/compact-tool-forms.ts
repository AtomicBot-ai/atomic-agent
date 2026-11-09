import type { ToolTier } from "./stable-prefix.js";

/**
 * The short form of a tool descriptor, rendered by the compact prompt
 * (`compact-prompt.ts`) instead of the full `summary` + `examples`.
 *
 * Authored, not derived: a truncated summary cuts the sentence that
 * mattered as often as the one that did not. Each entry keeps the
 * one-line purpose plus the rule that prevents a real small-model
 * failure (exact-match `oldString`, non-empty `cmd`, `prompt` required,
 * ...). `argsSchema` is never shortened, so the args the model sees
 * cannot drift from the grammar and the parser.
 *
 * `tier: "rare"` collapses a tool that is `frequent` in the full prompt
 * to a one-line manifest in compact mode; `tool.view` loads its full
 * schema. This is also the hook a later "hide rare tools behind search"
 * plugs into: the tier says which tools a small window can do without.
 */
export interface CompactToolForm {
  summary: string;
  tier?: ToolTier;
  /** Examples kept in compact mode. Omitted: none. */
  examples?: readonly string[];
}

const RARE = "rare" as const;

const FORMS: Record<string, CompactToolForm> = {
  "browser.navigate": {
    summary:
      "Open a URL in the browser. Last resort: to read a page use os.web.fetch, to search use os.web.search.",
  },
  "browser.click": { summary: "Click an element by aria-ref from the latest read_aria." },
  "browser.type": { summary: "Type into an element by aria-ref." },
  "browser.read_aria": {
    summary: "Page as an ARIA text snapshot (full, interactive, diff or region).",
  },
  "browser.search": {
    summary: "Search in the live browser. Last resort: use os.web.search.",
    tier: RARE,
  },
  "browser.tabs": { summary: "List, switch, close or open browser tabs.", tier: RARE },
  "browser.scroll": { summary: "Scroll the page; read_aria after if needed.", tier: RARE },
  "browser.screenshot": {
    summary: "JPEG of the page or one element; returns a path.",
    tier: RARE,
  },
  "os.shell.run": {
    summary:
      "Run a shell command in the working directory (may require approval). `cmd` is required and must not be empty. Not for deleting (os.fs.trash) or moving files (os.fs.move). A long command comes back as a job: wait, kill or list jobs.",
  },
  "os.fs.read": {
    summary: "Read a text or source file; offset/limit for a range, lineNumbers for 'LINE|'.",
  },
  "os.fs.write": {
    summary:
      "Create or overwrite a file (may require approval); always a file, never a folder. A file the request gave as input is refused: edit it with os.fs.edit or write a new file.",
  },
  "os.fs.restore": {
    summary: "Bring back a file os.fs.write / edit / patch replaced (may require approval).",
    tier: RARE,
  },
  "os.fs.trash": {
    summary: "Delete files or folders by moving them to the Trash (absolute paths; may require approval). Use instead of rm.",
  },
  "os.fs.list": {
    summary: "List one directory (max 200 entries); narrow with extensions, pattern or sort.",
  },
  "os.fs.glob": {
    summary: "Find files recursively by glob pattern (nocase=true ignores case).",
  },
  "os.fs.locate_project": {
    summary:
      "Find a project folder from the short folder name the user said (pass only that name). Several matches: ask the user.",
  },
  "os.fs.grep": {
    summary: "Regex search in file contents (ripgrep). Not for big binary trees like *.pdf.",
  },
  "os.fs.code_map": {
    summary:
      "Outline a code project (key files, symbols, line numbers) before reading; path = one file gives its skeleton.",
  },
  "os.fs.edit": {
    summary:
      "Replace text in a file (may require approval). oldString must match the file text exactly (copy it from os.fs.read, same indentation) and be unique unless replaceAll.",
  },
  "os.fs.read_document": {
    summary: "Text from PDF, Office, ODF or RTF documents. Not for source code: use os.fs.read.",
  },
  "os.fs.archive.list": { summary: "List archive entries.", tier: RARE },
  "os.fs.archive.read_entry": { summary: "Read one archive entry.", tier: RARE },
  "os.fs.archive.extract": { summary: "Extract an archive (may require approval).", tier: RARE },
  "os.fs.hash": { summary: "File digest.", tier: RARE },
  "os.fs.diff": { summary: "Unified diff of files or strings.", tier: RARE },
  "os.fs.patch": { summary: "Preview or apply a unified-diff patch.", tier: RARE },
  "os.fs.watch": { summary: "Wait for file changes once.", tier: RARE },
  "os.fs.move": {
    summary: "Move or rename files and folders; creates missing folders. Use instead of mv/mkdir.",
    tier: RARE,
  },
  "os.git.status": { summary: "Git status and current branch." },
  "os.git.log": { summary: "Commit history." },
  "os.git.diff": { summary: "Git diff (working tree, staged or revisions)." },
  "os.git.show": { summary: "One commit.", tier: RARE },
  "os.git.blame": { summary: "Per-line authorship.", tier: RARE },
  "os.git.branch": { summary: "List branches.", tier: RARE },
  "os.git.checkout": { summary: "Switch or create a branch (may require approval).", tier: RARE },
  "os.git.commit": { summary: "Commit with `message`; stage `paths` or `all` first (may require approval)." },
  "os.git.push": { summary: "Push a branch to a remote; never forces (may require approval).", tier: RARE },
  "os.git.remote": { summary: "List or change remotes.", tier: RARE },
  "os.git.fetch": { summary: "Fetch a remote.", tier: RARE },
  "os.git.pull": { summary: "Pull the upstream (fast-forward).", tier: RARE },
  "os.git.clone": { summary: "Clone a repository.", tier: RARE },
  "os.git.init": { summary: "Create a local git repository.", tier: RARE },
  "os.git.add": { summary: "Stage changes (`all` or `paths`)." },
  "github.whoami": { summary: "The connected GitHub account.", tier: RARE },
  "github.pr.list": { summary: "List pull requests.", tier: RARE },
  "github.pr.create": { summary: "Open a pull request (push first).", tier: RARE },
  "github.issue.list": { summary: "List issues.", tier: RARE },
  "github.issue.create": { summary: "File an issue.", tier: RARE },
  "github.issue.comment": { summary: "Comment on an issue or PR.", tier: RARE },
  "os.proc.list": { summary: "List processes.", tier: RARE },
  "os.proc.kill": { summary: "Signal a process (may require approval).", tier: RARE },
  "os.http.request": {
    summary: "Raw HTTP GET/POST for APIs. To read a web page use os.web.fetch.",
    tier: RARE,
  },
  "os.web.search": {
    summary: "Search the web; returns title/url/snippet. Read a result with os.web.fetch.",
  },
  "os.web.fetch": { summary: "Read a web page as markdown/text (GET, no JS)." },
  "os.clipboard.read": { summary: "Read the clipboard.", tier: RARE },
  "os.clipboard.write": { summary: "Write the clipboard.", tier: RARE },
  "os.window.list": { summary: "List windows.", tier: RARE },
  "os.window.focus": { summary: "Focus a window.", tier: RARE },
  "os.notify": { summary: "System notification.", tier: RARE },
  "os.email.inbox": { summary: "The agent's own e-mail inbox.", tier: RARE },
  "os.email.send": { summary: "Send an e-mail from the agent's inbox.", tier: RARE },
  "os.screen.capture": { summary: "Screenshot of the display; returns a path.", tier: RARE },
  "os.screen.click": { summary: "Click at x,y of the last capture (asks first).", tier: RARE },
  "os.screen.type": { summary: "Type text into the frontmost app (asks first).", tier: RARE },
  "os.screen.key": { summary: "Press a key or shortcut (asks first).", tier: RARE },
  "os.screen.point": {
    summary: "Draw arrows, boxes or labels on the user's screen to show where to click; never clicks.",
    tier: RARE,
  },
  "skill.view": { summary: "Load a skill's full instructions." },
  "tool.view": { summary: "Load the full args of a tool listed under # extras." },
  "tool.search": {
    summary: "Find a tool listed under # extras by what it should do; loads the best matches to call next step.",
    examples: ['{"query":"create a github issue"}'],
  },
  "plan.update": {
    summary: "Show a live checklist for work of 3+ steps; send the whole plan each call.",
    tier: RARE,
  },
  "skill.run_script": { summary: "Run a skill's script (may require approval).", tier: RARE },
  "memory.profile.set": {
    summary: "Save a durable user fact; pinned=false needs keywords.",
  },
  "memory.profile.remove": { summary: "Delete a profile fact.", tier: RARE },
  "memory.profile.list": { summary: "List profile facts.", tier: RARE },
  "memory.profile.history": { summary: "History of one profile key.", tier: RARE },
  "memory.notes.store": { summary: "Store a short durable note." },
  "memory.notes.recall": { summary: "Search notes, or fetch one by id." },
  "memory.notes.forget": { summary: "Delete a note.", tier: RARE },
  "memory.lessons.recall": { summary: "Read a lesson by id from `### lessons`, or search." },
  "memory.procedures.recall": {
    summary: "Read a procedure's steps by id from `### procedures`, or search.",
  },
  "tasks.schedule": { summary: "Schedule a one-shot task.", tier: RARE },
  "tasks.cron": { summary: "Schedule a recurring task.", tier: RARE },
  "tasks.list": { summary: "List tasks.", tier: RARE },
  "tasks.cancel": { summary: "Cancel a task.", tier: RARE },
  "tasks.show": { summary: "Show one task.", tier: RARE },
  "vision.describe": {
    summary: "Describe images (at most 4 per call). `prompt` is required.",
  },
  "image.generate": {
    summary: "Generate pictures (paid); show them via reply.attachments.",
    tier: RARE,
  },
  "video.generate": {
    summary: "Generate a short video clip (paid, slow); show it via reply.attachments.",
    tier: RARE,
  },
  "mcp.resource.list": { summary: "List an MCP server's resources.", tier: RARE },
  "mcp.resource.read": { summary: "Read an MCP resource.", tier: RARE },
  "mcp.prompt.list": { summary: "List an MCP server's prompt templates.", tier: RARE },
  "mcp.prompt.get": { summary: "Render an MCP prompt template.", tier: RARE },
  "verify.syntax": { summary: "Syntax-check files. Read-only.", tier: RARE },
  "verify.run": {
    summary: "Run what was built (command, service or page) on a throwaway copy and check the result.",
    tier: RARE,
  },
  "fusion.delegate": {
    summary: "Hand independent parts of the work to local workers; call it alone.",
    tier: RARE,
  },
  reply: {
    summary:
      "Final answer to the user; ends the turn. If an exact answer format is required, `text` is only that. `attachments`: file paths to send.",
  },
  finish: { summary: "End the session; only when the user asked." },
};

export const COMPACT_TOOL_FORMS: ReadonlyMap<string, CompactToolForm> = new Map(
  Object.entries(FORMS),
);
