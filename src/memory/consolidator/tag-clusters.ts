import type { MemoryEntry } from "../memory-store.js";

/**
 * Tag-first grouping for consolidation candidates that no link
 * component claimed (#903).
 *
 * The link graph is usually thin (a few edges for hundreds of notes),
 * so link components alone rarely reach `minClusterSize` and the
 * consolidator never wrote a lesson. Shared tags are the grouping
 * signal that every note carries, so the notes left over after the
 * link pass are grouped by tag here.
 *
 * Rules:
 *   - Provenance and lifecycle tags (`reflection` is stamped on every
 *     reflected note, `superseded` on every replaced one) say nothing
 *     about the topic and are never used to group.
 *   - Rarer tags go first: a tag held by 4 notes names a narrower
 *     topic than one held by 300. Ties break by tag name so the order
 *     is deterministic.
 *   - Each note joins at most one group, and a group holds at most
 *     `TAG_CLUSTER_MAX_MEMBERS` notes (oldest ids first) so one broad
 *     tag cannot pour hundreds of notes into a single distill prompt.
 *     The rest stay candidates for a later tick.
 */
export const TAG_CLUSTER_MAX_MEMBERS = 12;

// `reflection`: reflection-runner.ts stamps it on every reflected note.
// `superseded`: SUPERSEDED_NOTE_TAG in reconcile/note-reconcile-runner.ts
// (not imported, so this pure module does not pull the LLM client in).
const NON_TOPIC_TAGS: ReadonlySet<string> = new Set([
  "reflection",
  "superseded",
]);

/** False for provenance/lifecycle tags that do not name a topic. */
export function isTopicTag(tag: string): boolean {
  return tag.length > 0 && !NON_TOPIC_TAGS.has(tag);
}

export interface TagCluster {
  members: number[];
  sharedTags: string[];
}

export function clusterByTag(
  entries: readonly MemoryEntry[],
  minSize: number,
  maxClusters: number,
): TagCluster[] {
  if (maxClusters <= 0 || entries.length < minSize) return [];
  const holders = new Map<string, number[]>();
  for (const entry of entries) {
    for (const tag of new Set(entry.tags)) {
      if (!isTopicTag(tag)) continue;
      const list = holders.get(tag);
      if (list) list.push(entry.id);
      else holders.set(tag, [entry.id]);
    }
  }
  const tags = [...holders.keys()]
    .filter((tag) => holders.get(tag)!.length >= minSize)
    .sort((a, b) => {
      const diff = holders.get(a)!.length - holders.get(b)!.length;
      return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
    });
  const used = new Set<number>();
  const clusters: TagCluster[] = [];
  for (const tag of tags) {
    if (clusters.length >= maxClusters) break;
    const free = holders
      .get(tag)!
      .filter((id) => !used.has(id))
      .sort((a, b) => a - b);
    if (free.length < minSize) continue;
    const members = free.slice(0, TAG_CLUSTER_MAX_MEMBERS);
    for (const id of members) used.add(id);
    clusters.push({ members, sharedTags: [tag] });
  }
  return clusters;
}
