import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * Resolve a tool name the model emitted to one the registry holds.
 *
 * Qualified names carry dots — `fusion.delegate`, `os.fs.write` — and
 * the OpenAI wire format forbids them, so they travel as `__` and come
 * back through `nameUnescape`. A model that writes the escaped form
 * from memory rather than copying it gets the separator wrong, and the
 * near miss is not a typo in the usual sense: every character of the
 * name is right.
 *
 * That cost a real session its entire turn. The model emitted
 * `fusion_delegate`, one underscore short of the escape, twice; the
 * membership check in the step executor throws for the whole batch, so
 * a 30-minute turn ended with `reason=failed` over a separator.
 *
 * The candidates are deliberately narrow — separator confusion, case,
 * and wrapping the model or its chat template added. This is not fuzzy
 * matching: `os.fs.write` must never resolve to `os.fs.trash` because
 * the two are close. Every character of the tool's own name must be
 * there, in order; only separators, case and wrapping may differ, and
 * the form must point at exactly one registered tool. Anything else is
 * still unknown and gets the error result naming the closest tools
 * (`policies/unknown-tool.ts`).
 */
export function resolveToolName(
  name: string,
  registry: Pick<ToolRegistry, "has" | "list">,
): string | null {
  if (registry.has(name)) return name;

  // `fusion_delegate` → `fusion.delegate`, `os_fs_write` → `os.fs.write`.
  // Tried before `__` because a single-underscore name is the common
  // miss and the double form is what `nameUnescape` already handled.
  const singleToDot = name.replace(/_/g, ".");
  if (singleToDot !== name && registry.has(singleToDot)) return singleToDot;

  // A name that arrived still escaped: the text-JSON fallback path does
  // not run `nameUnescape`, so `fusion__delegate` can reach here whole.
  const doubleToDot = name.replace(/__/g, ".");
  if (doubleToDot !== name && registry.has(doubleToDot)) return doubleToDot;

  // Case only, over the two forms above as well — some models
  // capitalise the first letter of a tool name.
  const lower = name.toLowerCase();
  for (const { name: candidate } of registry.list()) {
    if (candidate.toLowerCase() === lower) return candidate;
    if (candidate.toLowerCase() === singleToDot.toLowerCase()) return candidate;
  }
  return resolveByShape(name, registry.list().map((definition) => definition.name));
}

const FUNCTIONS_PREFIX = "functions.";

/**
 * The name with what is not part of it taken off: a chat-template tail
 * (`os.fs.read<|channel|>commentary`, gpt-oss), surrounding quotes or
 * backticks, an empty call `()` and trailing punctuation.
 */
function stripWrapping(name: string): string {
  return name
    .replace(/<\|[\s\S]*$/, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\(\s*\)$/, "")
    .replace(/[:;,.!?]+$/, "");
}

/**
 * One spelling for every separator and case form of a name:
 * `mcp__brave_search__web_search`, `mcp.brave-search.web_search` and
 * `MCP.Brave-Search.Web-Search` all read `mcp.brave.search.web.search`.
 * Letters and digits are kept as they are, in order.
 */
function shapeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._-]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

/** The one element of `matches`, or `null` when there are none or several. */
function only(matches: ReadonlySet<string>): string | null {
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * The forms an emitted name is compared under: as written, and without
 * the `functions.` namespace OpenAI-style templates put in front of
 * every function (`functions.os.fs.read`, `functions__os__fs__read`).
 */
function emittedKeys(name: string): string[] {
  const key = shapeKey(stripWrapping(name));
  if (key.length === 0) return [];
  return key.startsWith(FUNCTIONS_PREFIX) && key.length > FUNCTIONS_PREFIX.length
    ? [key, key.slice(FUNCTIONS_PREFIX.length)]
    : [key];
}

/**
 * The whole name in another spelling of exactly one registered tool:
 * separators and case over names with underscores or hyphens of their
 * own (`mcp_github_create_issue`, `mcp.brave_search.brave_web_search`
 * for `mcp.brave-search.brave_web_search`), wrapping (`"os.fs.read"`,
 * `os.fs.read()`) and the `functions.` namespace. Two tools that share
 * a spelling (`mcp.a.b_c` and `mcp.a_b.c`) resolve to neither.
 *
 * A name with part of the real one missing is not resolved, however
 * likely the match: `write_file` may be meant for `os.fs.write` or an
 * MCP filesystem server's `write_file`, `github.create_issue` for the
 * built-in GitHub tool or an MCP server's. Those get the error result
 * naming the candidates, and the model picks (ATO-1674).
 */
function resolveByShape(name: string, registered: readonly string[]): string | null {
  const keys = emittedKeys(name);
  if (keys.length === 0) return null;
  const matches = new Set<string>();
  for (const candidate of registered) {
    if (keys.includes(shapeKey(candidate))) matches.add(candidate);
  }
  return only(matches);
}
