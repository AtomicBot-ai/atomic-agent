/**
 * E1 queries — 5 paraphrased queries per cluster, 50 total.
 *
 * Design notes:
 *
 *  - Each query is **labelled** with its target `clusterId` (matches
 *    `CorpusCluster.id` in corpus.ts). Hits on any note in that cluster
 *    count as relevant.
 *  - Three difficulty bands per cluster:
 *      easy   — at least 1 obvious shared token with several notes
 *      mid    — synonyms or genre vocabulary; BM25 has to work
 *      hard   — abstract / structural references; BM25 likely misses
 *    The runner reports per-band breakdowns so we can see how the
 *    difficulty curve responds to embeddings vs BM25-only.
 *  - The wording is deliberately operator-natural ("how do I X?",
 *    "what is X?", "X tradeoffs") rather than keyword soup. Production
 *    queries from real users have this shape and BM25-only retrieval
 *    is known to struggle with it.
 */

export type QueryDifficulty = "easy" | "mid" | "hard";

export interface E1Query {
  /** Stable ordinal for joining metrics across runs. */
  id: string;
  clusterId: number;
  difficulty: QueryDifficulty;
  query: string;
}

export const E1_QUERIES: readonly E1Query[] = [
  // ---- cluster 0 — async-js ----
  { id: "q-async-1", clusterId: 0, difficulty: "easy", query: "promise chaining and error propagation" },
  { id: "q-async-2", clusterId: 0, difficulty: "easy", query: "Promise.all versus Promise.allSettled tradeoffs" },
  { id: "q-async-3", clusterId: 0, difficulty: "mid", query: "how do I cancel an in-flight async operation cleanly" },
  { id: "q-async-4", clusterId: 0, difficulty: "mid", query: "running independent async work concurrently inside a loop" },
  { id: "q-async-5", clusterId: 0, difficulty: "hard", query: "scheduling fine-grained work to defer past the current job" },

  // ---- cluster 1 — sql-opt ----
  { id: "q-sql-1", clusterId: 1, difficulty: "easy", query: "EXPLAIN ANALYZE and execution plans" },
  { id: "q-sql-2", clusterId: 1, difficulty: "easy", query: "composite index column ordering" },
  { id: "q-sql-3", clusterId: 1, difficulty: "mid", query: "covering indexes and what makes them effective" },
  { id: "q-sql-4", clusterId: 1, difficulty: "mid", query: "why my query suddenly got slow after a data spike" },
  { id: "q-sql-5", clusterId: 1, difficulty: "hard", query: "trading freshness for read latency on expensive joins" },

  // ---- cluster 2 — coffee ----
  { id: "q-coffee-1", clusterId: 2, difficulty: "easy", query: "espresso extraction parameters" },
  { id: "q-coffee-2", clusterId: 2, difficulty: "easy", query: "pour-over bloom timing" },
  { id: "q-coffee-3", clusterId: 2, difficulty: "mid", query: "diagnose sour or bitter shots" },
  { id: "q-coffee-4", clusterId: 2, difficulty: "mid", query: "how does cold brew differ from hot extraction" },
  { id: "q-coffee-5", clusterId: 2, difficulty: "hard", query: "evaluating extraction strength quantitatively" },

  // ---- cluster 3 — py-types ----
  { id: "q-py-1", clusterId: 3, difficulty: "easy", query: "TypedDict for dict shape" },
  { id: "q-py-2", clusterId: 3, difficulty: "easy", query: "Protocol structural typing" },
  { id: "q-py-3", clusterId: 3, difficulty: "mid", query: "describing multiple call signatures of the same function" },
  { id: "q-py-4", clusterId: 3, difficulty: "mid", query: "how do generic containers handle subtype substitution" },
  { id: "q-py-5", clusterId: 3, difficulty: "hard", query: "attaching metadata to a type without changing its meaning" },

  // ---- cluster 4 — linux-perms ----
  { id: "q-lin-1", clusterId: 4, difficulty: "easy", query: "chmod octal mode for owner group other" },
  { id: "q-lin-2", clusterId: 4, difficulty: "easy", query: "sticky bit on /tmp" },
  { id: "q-lin-3", clusterId: 4, difficulty: "mid", query: "granting a binary one root power without full root" },
  { id: "q-lin-4", clusterId: 4, difficulty: "mid", query: "extending permissions beyond owner-group-other for specific users" },
  { id: "q-lin-5", clusterId: 4, difficulty: "hard", query: "mandatory access control on top of standard permissions" },

  // ---- cluster 5 — git-rebase ----
  { id: "q-git-1", clusterId: 5, difficulty: "easy", query: "interactive rebase to squash commits" },
  { id: "q-git-2", clusterId: 5, difficulty: "easy", query: "force pushing after rebase safely" },
  { id: "q-git-3", clusterId: 5, difficulty: "mid", query: "recovering lost commits after a botched rewrite" },
  { id: "q-git-4", clusterId: 5, difficulty: "mid", query: "moving a feature branch onto a different base" },
  { id: "q-git-5", clusterId: 5, difficulty: "hard", query: "why my GPG signed commits show as unverified after I rewrote history" },

  // ---- cluster 6 — docker-net ----
  { id: "q-dock-1", clusterId: 6, difficulty: "easy", query: "publishing container ports to the host" },
  { id: "q-dock-2", clusterId: 6, difficulty: "easy", query: "service discovery between containers by name" },
  { id: "q-dock-3", clusterId: 6, difficulty: "mid", query: "running containers across multiple machines on the same virtual network" },
  { id: "q-dock-4", clusterId: 6, difficulty: "mid", query: "giving containers their own MAC on the physical LAN" },
  { id: "q-dock-5", clusterId: 6, difficulty: "hard", query: "diagnosing silent TCP retransmits between containers" },

  // ---- cluster 7 — css-flex ----
  { id: "q-css-1", clusterId: 7, difficulty: "easy", query: "justify-content vs align-items" },
  { id: "q-css-2", clusterId: 7, difficulty: "easy", query: "flex-grow and flex-shrink defaults" },
  { id: "q-css-3", clusterId: 7, difficulty: "mid", query: "long text overflowing a flex column" },
  { id: "q-css-4", clusterId: 7, difficulty: "mid", query: "pushing a single item to the far end of the row" },
  { id: "q-css-5", clusterId: 7, difficulty: "hard", query: "when does flexbox fall short and grid wins" },

  // ---- cluster 8 — rest-api ----
  { id: "q-rest-1", clusterId: 8, difficulty: "easy", query: "ETag and conditional GETs" },
  { id: "q-rest-2", clusterId: 8, difficulty: "easy", query: "cursor-based pagination vs offset" },
  { id: "q-rest-3", clusterId: 8, difficulty: "mid", query: "handling long-running operations without blocking the client" },
  { id: "q-rest-4", clusterId: 8, difficulty: "mid", query: "telling clients about quotas before they get rejected" },
  { id: "q-rest-5", clusterId: 8, difficulty: "hard", query: "designing partial updates that are unambiguous and well-specified" },

  // ---- cluster 9 — fp ----
  { id: "q-fp-1", clusterId: 9, difficulty: "easy", query: "pure functions and side effects" },
  { id: "q-fp-2", clusterId: 9, difficulty: "easy", query: "map filter reduce on collections" },
  { id: "q-fp-3", clusterId: 9, difficulty: "mid", query: "chaining computations that may fail without exceptions" },
  { id: "q-fp-4", clusterId: 9, difficulty: "mid", query: "encoding states as a closed set of variants" },
  { id: "q-fp-5", clusterId: 9, difficulty: "hard", query: "modeling effects so business logic stays free of IO concerns" },
];
