/**
 * ATO-2483: the network choice of the shared model (`shareNetwork`) never
 * outlives an off. The parser already ignores it while `share` is off;
 * this drops it from a raw config tree about to be written, so a later
 * `config set localModels.managed.share true` (or the Diagnostics settings
 * editor) turns sharing back on for this computer only, never for the
 * network the person chose some earlier time.
 *
 * Returns `tree` itself when nothing changes, else a copy without the key.
 */
export function withoutStaleShareNetwork(tree: Record<string, unknown>): Record<string, unknown> {
  const local = tree.localModels;
  if (!isPlainObject(local)) return tree;
  const managed = local.managed;
  if (!isPlainObject(managed) || !Object.hasOwn(managed, "shareNetwork")) return tree;
  if (readsAsOn(managed.share)) return tree;
  const { shareNetwork: _forgotten, ...rest } = managed;
  return { ...tree, localModels: { ...local, managed: rest } };
}

/** The values `parseBool` (config-primitives.ts) reads as true. */
function readsAsOn(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
