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
 * wrapping the model or its chat template added, and the `mcp.<server>.`
 * namespace written short. This is not fuzzy matching: `os.fs.write`
 * must never resolve to `os.fs.trash` because the two are close. Every
 * character of the tool's own name must be there; only separators,
 * case and a namespace prefix may differ, and the form must point at
 * exactly one registered tool. Anything else is still unknown and gets
 * the error result naming the closest tools (`policies/unknown-tool.ts`).
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

const MCP_PREFIX = "mcp.";
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
 * Separator, case, wrapping and namespace forms that point at exactly
 * one registered tool. Two tiers, each of which must be unambiguous
 * (the second over both of its short forms together):
 *
 *  1. The whole name in another spelling (`mcp_github_create_issue`,
 *     `mcp.brave_search.web_search` for `mcp.brave-search.web_search`,
 *     `"os.fs.read"`, `functions.os.fs.read`).
 *  2. An MCP tool written without its `mcp.` namespace
 *     (`github.create_issue`) or by the server's own name for it alone
 *     (`create_issue`, `mcp.create_issue`, Composio's
 *     `GITHUB_CREATE_ISSUE`). The bare form needs two words or more.
 *     Either short form resolves only when no built-in tool ends in the
 *     same words, so `web_search` never picks an MCP `web_search` over
 *     `os.web.search`, nor `fs.write` an MCP `fs.write` over `os.fs.write`.
 */
function resolveByShape(name: string, registered: readonly string[]): string | null {
  const keys = emittedKeys(name);
  if (keys.length === 0) return null;

  const whole = new Set<string>();
  for (const candidate of registered) {
    if (keys.includes(shapeKey(candidate))) whole.add(candidate);
  }
  if (whole.size > 0) return only(whole);

  // `mcp.create_issue`: the namespace kept, the server dropped. A bare
  // name of one word (`search`, `get`) is too common to stand for one
  // server's tool and is left to the error result.
  const bareKeys = keys
    .flatMap((key) =>
      key.startsWith(MCP_PREFIX) ? [key, key.slice(MCP_PREFIX.length)] : [key],
    )
    .filter((key) => key.includes("."));
  const qualified = new Set<string>();
  const bare = new Set<string>();
  // A built-in tool ending in the same words (`os.fs.write` for
  // `fs.write`) makes the short form ambiguous: refuse rather than pick.
  let builtInEndsLikeQualified = false;
  let builtInEndsLikeBare = false;
  const endsLike = (key: string, forms: readonly string[]) =>
    forms.some((form) => key.endsWith(`.${form}`));
  for (const candidate of registered) {
    const key = shapeKey(candidate);
    if (!key.startsWith(MCP_PREFIX)) {
      if (endsLike(key, keys)) builtInEndsLikeQualified = true;
      if (endsLike(key, bareKeys)) builtInEndsLikeBare = true;
      continue;
    }
    const rest = candidate.slice(MCP_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot >= rest.length - 1) continue;
    if (keys.includes(shapeKey(rest))) qualified.add(candidate);
    if (bareKeys.includes(shapeKey(rest.slice(dot + 1)))) bare.add(candidate);
  }
  if (qualified.size > 0 && builtInEndsLikeQualified) return null;
  if (bare.size > 0 && builtInEndsLikeBare) return null;
  return only(new Set([...qualified, ...bare]));
}
