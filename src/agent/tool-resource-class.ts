/**
 * Resource class taxonomy for parallel batched tool calls.
 *
 * The batch executor groups calls by `ResourceClass`:
 *  - `pure_read`     — parallel-safe; no shared mutable state. Runs as
 *                      `Promise.allSettled`.
 *  - `fs_write`      — file-system writes. Serialised within its group
 *                      to keep behaviour deterministic when the model
 *                      writes multiple files in one batch. (Note: most
 *                      fs_write verbs also require approval, so they
 *                      additionally land in `approval_gated` and are
 *                      forbidden inside a batch entirely.)
 *  - `browser`       — Playwright is a single-process resource. All
 *                      `browser.*` calls serialise within their group.
 *  - `memory_write`  — `ProfileStore` / `MemoryStore` writes. Serialised
 *                      to keep observation order predictable, even
 *                      though `better-sqlite3` is synchronous.
 *  - `tasks_write`   — Task store mutations. Same rationale.
 *  - `vision`        — `vision.describe` issues HTTP calls to a separate
 *                      llama-server slot; serialised to bound concurrent
 *                      vision load on the backend.
 *  - `approval_gated`— Virtual class. Tools that may invoke
 *                      `requireApproval` synchronously inside `run()`.
 *                      Forbidden inside a batch — the validator rejects
 *                      the parse and the model is asked to split.
 *  - `terminal`      — `reply` / `finish`. Allowed only as the LAST
 *                      element of a multi-call batch; mid-batch or
 *                      duplicated terminals are rejected. The executor
 *                      runs the terminal call strictly after every
 *                      non-terminal call has settled, so `[store, reply]`
 *                      collapses into one inference whose transcript is
 *                      `tool_call(store) → tool_result(store) →
 *                      assistant_reply`. Solo terminal calls keep the
 *                      legacy semantics (length-1 batch).
 *
 * Groups in distinct classes execute concurrently with each other; the
 * total step wall is `max(group durations)`.
 *
 * Tools not listed here default to `unknown`, which the validator
 * rejects from any batch (fail-closed). When you add a new tool, add
 * its name here too — the test in `tool-resource-class.test.ts`
 * asserts that every entry in `DEFAULT_TOOL_DESCRIPTORS` has an
 * explicit class.
 */
export type ResourceClass =
  | "pure_read"
  | "fs_write"
  | "browser"
  | "memory_write"
  | "tasks_write"
  | "vision"
  | "approval_gated"
  | "terminal"
  | "unknown";

const TOOL_RESOURCE_CLASS: Record<string, ResourceClass> = {
  // browser.* — single Playwright backend per process
  "browser.navigate": "browser",
  "browser.click": "browser",
  "browser.type": "browser",
  "browser.read_aria": "browser",
  "browser.search": "browser",
  "browser.tabs": "browser",
  "browser.scroll": "browser",

  // os.shell.* — always approval-gated when approvals are on
  "os.shell.run": "approval_gated",

  // os.fs.* read-only
  "os.fs.read": "pure_read",
  "os.fs.read_document": "pure_read",
  "os.fs.list": "pure_read",
  "os.fs.glob": "pure_read",
  "os.fs.grep": "pure_read",
  "os.fs.hash": "pure_read",
  "os.fs.diff": "pure_read",
  "os.fs.watch": "pure_read",
  "os.fs.archive.list": "pure_read",
  "os.fs.archive.read_entry": "pure_read",

  // os.fs.* mutating — all approval-gated
  "os.fs.write": "approval_gated",
  "os.fs.edit": "approval_gated",
  "os.fs.trash": "approval_gated",
  "os.fs.patch": "approval_gated",
  "os.fs.archive.extract": "approval_gated",

  // os.git.* — read-only shell-outs
  "os.git.status": "pure_read",
  "os.git.log": "pure_read",
  "os.git.diff": "pure_read",
  "os.git.show": "pure_read",
  "os.git.blame": "pure_read",
  "os.git.branch": "pure_read",

  // os.proc.*
  "os.proc.list": "pure_read",
  "os.proc.kill": "approval_gated",

  // os.http.*
  "os.http.request": "approval_gated",

  // os.clipboard / window / notify — small mutating side effects on
  // shared OS resources; safest to serialise.
  "os.clipboard.read": "pure_read",
  "os.clipboard.write": "memory_write",
  "os.window.list": "pure_read",
  "os.window.focus": "memory_write",
  "os.notify": "memory_write",

  // discovery
  "skill.view": "pure_read",
  "tool.view": "pure_read",
  "skill.run_script": "approval_gated",

  // memory.*
  "memory.profile.list": "pure_read",
  "memory.profile.history": "pure_read",
  "memory.lessons.recall": "pure_read",
  "memory.procedures.recall": "pure_read",
  "memory.notes.recall": "pure_read",
  "memory.profile.set": "memory_write",
  "memory.profile.remove": "memory_write",
  "memory.notes.store": "memory_write",
  "memory.notes.forget": "memory_write",

  // tasks.*
  "tasks.list": "pure_read",
  "tasks.show": "pure_read",
  "tasks.schedule": "tasks_write",
  "tasks.cron": "tasks_write",
  "tasks.cancel": "tasks_write",

  // vision
  "vision.describe": "vision",

  // mcp.* discovery / read tools — pure_read regardless of per-server
  // trust because they only inspect the local catalog or fetch
  // declared resources/prompts. Per-server-tool calls go through
  // `mcp.<server>.<name>` and are classified by the dynamic resolver.
  "mcp.resource.list": "pure_read",
  "mcp.resource.read": "pure_read",
  "mcp.prompt.list": "pure_read",
  "mcp.prompt.get": "pure_read",

  // terminal verbs
  reply: "terminal",
  finish: "terminal",
};

/**
 * Optional resolver for tool names that are not in the static
 * `TOOL_RESOURCE_CLASS` table. Set once at bootstrap by the MCP
 * manager so MCP-namespaced tools (`mcp.<server>.<name>`) get a real
 * class instead of falling through to `unknown` (which would forbid
 * them from every batch — including length-1 batches). The resolver
 * is consulted only when the static lookup misses, so it cannot
 * override the built-in classes.
 */
let dynamicResourceClassResolver: ((toolName: string) => ResourceClass | null) | null = null;

/**
 * Install a dynamic resolver. Pass `null` to unregister (e.g. during
 * runtime shutdown). The setter is intentionally narrow — the
 * resolver is read on every `resourceClassFor` call and must be
 * cheap (a Map lookup at the call site).
 */
export function setDynamicResourceClassResolver(
  resolver: ((toolName: string) => ResourceClass | null) | null,
): void {
  dynamicResourceClassResolver = resolver;
}

/**
 * Lookup helper. Unknown tools land in `unknown` so the validator can
 * reject them from any batch — this is the fail-closed default.
 *
 * For names not in the static table, the dynamic resolver (if any)
 * is consulted. This is the seam through which MCP-namespaced tools
 * (`mcp.<server>.<name>`) get a non-`unknown` class.
 */
export function resourceClassFor(toolName: string): ResourceClass {
  const builtin = TOOL_RESOURCE_CLASS[toolName];
  if (builtin) return builtin;
  if (dynamicResourceClassResolver) {
    const resolved = dynamicResourceClassResolver(toolName);
    if (resolved) return resolved;
  }
  return "unknown";
}

/** True when the class may run alongside other calls in a batch. */
export function isBatchable(cls: ResourceClass): boolean {
  return cls !== "approval_gated" && cls !== "terminal" && cls !== "unknown";
}

/**
 * True when the class can run concurrently with siblings of the same
 * class (currently only `pure_read`). All other batchable classes
 * serialise within their group.
 */
export function isParallelWithinGroup(cls: ResourceClass): boolean {
  return cls === "pure_read";
}

/**
 * Read-only snapshot of the registry — useful for tests and debugging.
 */
export function listKnownToolResourceClasses(): Readonly<
  Record<string, ResourceClass>
> {
  return TOOL_RESOURCE_CLASS;
}
