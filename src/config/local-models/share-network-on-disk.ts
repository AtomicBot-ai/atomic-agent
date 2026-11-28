/**
 * ATO-2483: the network choice of the shared model (`shareNetwork`) never
 * outlives an off. The parser already ignores it while `share` is off;
 * this drops it from a raw config tree about to be written, so a later
 * `config set localModels.managed.share true` (or the Diagnostics settings
 * editor) turns sharing back on for this computer only, never for the
 * network the person chose some earlier time.
 *
 * `disk` is the tree on disk before this write. A write that turns
 * sharing on from off (`config set localModels.managed.share true` over a
 * file an older build or a hand edit left as `{share:false,
 * shareNetwork:true}`) drops it too: enabling by a raw write is always
 * this computer only. The network is chosen through `models share
 * --network` or the desktop card (model-share-settings.ts).
 *
 * Returns `tree` itself when nothing changes, else a copy without the key.
 */
export function withoutStaleShareNetwork(tree: Record<string, unknown>, disk: Record<string, unknown> | null = null): Record<string, unknown> {
  const local = tree.localModels;
  if (!isPlainObject(local)) return tree;
  const managed = local.managed;
  if (!isPlainObject(managed) || !Object.hasOwn(managed, "shareNetwork")) return tree;
  if (readsAsOn(managed.share) && (disk === null || readsAsOn(shareOf(disk)))) return tree;
  const { shareNetwork: _forgotten, ...rest } = managed;
  return { ...tree, localModels: { ...local, managed: rest } };
}

/** `localModels.managed.share` of a raw tree, `undefined` when absent. */
function shareOf(tree: Record<string, unknown>): unknown {
  const local = tree.localModels;
  if (!isPlainObject(local) || !isPlainObject(local.managed)) return undefined;
  return local.managed.share;
}

/** The values `parseBool` (config-primitives.ts) reads as true. */
function readsAsOn(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
