import type { MemoryEntry } from "../memory-store.js";
import type { LinkStore } from "../links/link-store.js";

/**
 * Memory-v2 phase 5. Cluster cold-path consolidation candidates into
 * connected components of the link graph, optionally requiring that
 * **every member of a cluster shares at least one tag with every
 * other member** (the user-selected "CC + tag-intersection" mode).
 *
 * Strategy:
 *   1. Walk the candidate set as an undirected graph using the link
 *      store's `listOutgoing` / `listIncoming` API (links are
 *      directed but expand both ways — see `LinkStore.expand`
 *      for the rationale). Edges to nodes outside the candidate
 *      set are ignored at this stage.
 *   2. BFS each unvisited node to extract its connected component.
 *      Only nodes still inside the candidate set are followed —
 *      this is **subgraph clustering**, not the full graph.
 *   3. Apply the size floor `minClusterSize`. Smaller components
 *      drop out.
 *   4. If `requireSharedTag` is `true`, split each CC by tag
 *      cohesion: pick the most-common tag among the CC's members,
 *      then **keep only the members that carry that tag**. The
 *      truncated component then re-applies the size floor.
 *
 * The reason for the "majority tag, then filter" step is so a CC of
 * `[E1, E2, E3, E4]` where three share `pnpm` and one is an
 * unrelated debug note becomes `[E1, E2, E3]` rather than getting
 * thrown away outright. Doc §6.3 step 2 is fuzzy on this — we pick
 * the version that keeps more lessons on the floor.
 *
 * Returns clusters in deterministic order (smallest minimum id
 * first). Each cluster's member ids are sorted ascending. This
 * predictability matters for the distill-grammar's prompt where
 * we always feed the LLM the same row order.
 */
export interface ClusteringOptions {
  minClusterSize: number;
  /** When `true`, every member must share the majority tag. */
  requireSharedTag: boolean;
  /** Hard cap on how many clusters we emit per call. */
  maxClusters: number;
}

export interface ClusteringDeps {
  linkStore: LinkStore;
}

/**
 * One CC produced by the clusterer. `members` is sorted ascending
 * by id; `sharedTags` is non-empty only when
 * `requireSharedTag=true` (the majority tag that bound the cluster
 * together).
 */
export interface MemoryCluster {
  members: number[];
  sharedTags: string[];
}

export function clusterEpisodes(
  candidates: readonly MemoryEntry[],
  opts: ClusteringOptions,
  deps: ClusteringDeps,
): MemoryCluster[] {
  if (candidates.length === 0) return [];
  if (opts.maxClusters <= 0) return [];
  const minSize = Math.max(2, opts.minClusterSize);
  const idSet = new Set<number>();
  const byId = new Map<number, MemoryEntry>();
  for (const entry of candidates) {
    idSet.add(entry.id);
    byId.set(entry.id, entry);
  }

  // Build undirected adjacency restricted to the candidate set.
  // Walking the link store node-by-node is fine here: phase 5
  // candidate sets are bounded by `cooldownMs` + scheduler tick
  // throughput. Anything bigger should be paged by the caller.
  const adjacency = new Map<number, Set<number>>();
  for (const id of idSet) adjacency.set(id, new Set<number>());
  for (const id of idSet) {
    const out = deps.linkStore.listOutgoing(id);
    for (const edge of out) {
      if (!idSet.has(edge.toId)) continue;
      adjacency.get(id)!.add(edge.toId);
      adjacency.get(edge.toId)!.add(id);
    }
    const inc = deps.linkStore.listIncoming(id);
    for (const edge of inc) {
      if (!idSet.has(edge.fromId)) continue;
      adjacency.get(id)!.add(edge.fromId);
      adjacency.get(edge.fromId)!.add(id);
    }
  }

  const visited = new Set<number>();
  const components: MemoryCluster[] = [];
  // Walk seeds in id-ascending order so a stable distill prompt
  // order falls out for free.
  const seedOrder = [...idSet].sort((a, b) => a - b);
  for (const seed of seedOrder) {
    if (visited.has(seed)) continue;
    const component = bfsCc(seed, adjacency, visited);
    if (component.length < minSize) continue;
    if (!opts.requireSharedTag) {
      components.push({
        members: component.sort((a, b) => a - b),
        sharedTags: [],
      });
      continue;
    }
    const trimmed = trimByMajorityTag(component, byId);
    if (trimmed.members.length < minSize) continue;
    components.push(trimmed);
  }

  components.sort((a, b) => a.members[0]! - b.members[0]!);
  return components.slice(0, opts.maxClusters);
}

function bfsCc(
  seed: number,
  adjacency: Map<number, Set<number>>,
  visited: Set<number>,
): number[] {
  const queue: number[] = [seed];
  const result: number[] = [];
  visited.add(seed);
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    const neighbours = adjacency.get(node);
    if (!neighbours) continue;
    for (const next of neighbours) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return result;
}

/**
 * Pick the most-common tag among CC members, then return the
 * subset of members that carry it. Ties broken by lexicographic
 * order so the choice stays deterministic.
 */
function trimByMajorityTag(
  ids: readonly number[],
  byId: Map<number, MemoryEntry>,
): MemoryCluster {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue;
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return { members: [], sharedTags: [] };
  }
  let bestTag = "";
  let bestCount = 0;
  const sortedTags = [...counts.keys()].sort();
  for (const tag of sortedTags) {
    const c = counts.get(tag)!;
    if (c > bestCount) {
      bestTag = tag;
      bestCount = c;
    }
  }
  const filtered: number[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (entry.tags.includes(bestTag)) filtered.push(id);
  }
  filtered.sort((a, b) => a - b);
  return {
    members: filtered,
    sharedTags: bestTag.length > 0 ? [bestTag] : [],
  };
}
