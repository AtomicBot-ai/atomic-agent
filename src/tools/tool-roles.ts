/**
 * A tool set per role.
 *
 * Every turn used to see every tool: a fusion worker got the whole
 * catalog minus nine names (about 85 built-ins, described twice on a
 * native-tool provider — as prompt text and as JSON schemas — so run
 * 14's worker prompts opened at ~13.8K tokens), and the local grammar
 * enumerated ~80 names for every role. A role names the tools a turn
 * is FOR: a builder reads, writes, runs and checks; an orchestrator
 * reads, checks, delegates and replies; a normal turn keeps everything.
 *
 * A role shapes three things, once per transport:
 *  - the `### tools` block lists the role's tools in full (frequent) or
 *    as one-liners (rare) and the rest as ONE line of names, "also
 *    available via tool.view" — so the prefix is per role, not per
 *    turn, and a role change is one cold read;
 *  - a native-tool provider receives the role's tools as JSON schemas
 *    (plus what the session has loaded), not the whole catalog;
 *  - the local grammar admits the role's names (plus loaded ones).
 *
 * A tool outside the role is not gone: `tool.view { name }` loads its
 * descriptor into `### loaded-tools`, after which it is described,
 * callable and in the grammar. That costs a step, which is the point —
 * the common case pays nothing for the long tail.
 *
 * The sets are NAMES, checked by predicate, so a role tolerates a tool
 * that is not registered in this build (`verify.*` lands from another
 * package; an MCP server may or may not be connected). A name a role
 * admits but no registry holds is simply never a descriptor.
 */

export type ToolRole = "builder" | "orchestrator" | "full";

export const TOOL_ROLES: readonly ToolRole[] = ["builder", "orchestrator", "full"];

/** The terminals and the two discovery tools every role keeps. */
const REPLY = "reply";
const FINISH = "finish";

/**
 * `os.fs.*` tools that only read. The orchestrator's whole filesystem
 * surface, and the read half of the builder's.
 */
const FS_READ_TOOLS: readonly string[] = [
  "os.fs.read",
  "os.fs.read_document",
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.hash",
  "os.fs.diff",
  "os.fs.watch",
  "os.fs.locate_project",
  "os.fs.archive.list",
  "os.fs.archive.read_entry",
];

/** `os.fs.*` tools that change the working tree. Builder only. */
const FS_WRITE_TOOLS: readonly string[] = [
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
];

/** Long-term memory READS: the orchestrator plans against what is known. */
const MEMORY_READ_TOOLS: readonly string[] = [
  "memory.profile.list",
  "memory.profile.history",
  "memory.notes.recall",
  "memory.lessons.recall",
  "memory.procedures.recall",
];

interface RoleSpec {
  names: ReadonlySet<string>;
  /** Name prefixes admitted wholesale (`verify.` admits `verify.syntax`). */
  prefixes: readonly string[];
}

/**
 * A builder does the work: files in and out, a shell, the checks that
 * prove the work runs, the two discovery tools, and every MCP tool
 * (an MCP server is mounted precisely so a worker can use it). No
 * `finish` — a worker ending its own throwaway session is read the
 * same as a reply, and a normal turn is not a builder.
 */
const BUILDER: RoleSpec = {
  names: new Set([
    ...FS_READ_TOOLS.filter(
      (name) =>
        name !== "os.fs.locate_project" && !name.startsWith("os.fs.archive."),
    ),
    ...FS_WRITE_TOOLS,
    "os.shell.run",
    "tool.view",
    "skill.view",
    REPLY,
  ]),
  prefixes: ["verify.", "mcp."],
};

/**
 * An orchestrator plans, checks and delegates; it never builds (the
 * fusion gate refuses every mutation anyway — see
 * `fusion-orchestrator-mode.ts`). D1: read-only verification is its
 * to run. No MCP tools: the gate treats them as mutating, so listing
 * them would only advertise refusals.
 */
const ORCHESTRATOR: RoleSpec = {
  names: new Set([
    ...FS_READ_TOOLS,
    ...MEMORY_READ_TOOLS,
    "fusion.delegate",
    "tool.view",
    REPLY,
    FINISH,
  ]),
  prefixes: ["verify."],
};

/** Does `role` list `name` — i.e. describe it in full and admit it unloaded? */
export function roleAdmits(role: ToolRole, name: string): boolean {
  if (role === "full") return true;
  const spec = role === "builder" ? BUILDER : ORCHESTRATOR;
  if (spec.names.has(name)) return true;
  return spec.prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Split descriptors into the role's own and the rest. `full` (and an
 * absent role) keeps everything on the inside, so a caller that
 * partitions unconditionally renders byte-identical output for it.
 */
export function partitionByRole<T extends { name: string }>(
  role: ToolRole | undefined,
  descriptors: readonly T[],
): { inRole: T[]; outside: T[] } {
  if (role === undefined || role === "full") {
    return { inRole: [...descriptors], outside: [] };
  }
  const inRole: T[] = [];
  const outside: T[] = [];
  for (const d of descriptors) {
    (roleAdmits(role, d.name) ? inRole : outside).push(d);
  }
  return { inRole, outside };
}

/**
 * The descriptors a step under `role` describes in full and puts on the
 * wire: the role's own, plus any the session has loaded through
 * `tool.view` (`loaded` is their names). Everything else stays reachable
 * by loading it.
 */
export function descriptorsForRole<T extends { name: string }>(
  role: ToolRole | undefined,
  descriptors: readonly T[],
  loaded: ReadonlySet<string>,
): readonly T[] {
  if (role === undefined || role === "full") return descriptors;
  return descriptors.filter(
    (d) => roleAdmits(role, d.name) || loaded.has(d.name),
  );
}
