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
 * The candidates are deliberately narrow — separator confusion and
 * case, nothing else. This is not fuzzy matching: `os.fs.write` must
 * never resolve to `os.fs.trash` because the two are close. A name that
 * does not resolve exactly, or by fixing the separator it was clearly
 * trying to use, is still unknown and still fails.
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
  return null;
}
