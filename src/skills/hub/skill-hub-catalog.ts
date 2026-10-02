import { parseSkillFile } from "../skill-manifest.js";
import {
  GithubSkillError,
  type RemoteSkillManifestRef,
  type SkillHubClient,
} from "./github-skill-client.js";
import {
  formatSkillIdentifier,
  parseTapRepo,
  type SkillTap,
} from "./skill-hub-source.js";

/**
 * Discovery layer over {@link SkillHubClient}. Walks each tap's tree for
 * `SKILL.md` files, parses their frontmatter, and returns compact
 * catalog rows. Per-skill parse failures are skipped so one malformed
 * manifest never breaks a whole browse.
 */

export interface HubSkillEntry {
  /** Canonical install identifier (`owner/repo[/dir]` or `@owner/slug`). */
  identifier: string;
  name: string;
  description: string;
  version: string;
  /** `owner/repo` (GitHub) or publisher handle (ClawHub). */
  repo: string;
  /** Repo-relative skill dir, "" for root. */
  dir: string;
  /**
   * Origin registry. Drives install routing (GitHub tap vs ClawHub
   * registry) and the source badge in the TUI. Defaults to `github`.
   */
  source: "github" | "clawhub";
  /**
   * All-time download count. Present for ClawHub rows (the registry
   * tracks it); `undefined` for GitHub taps which expose no such metric.
   */
  downloads?: number;
}

/** Bounded fan-out so a large tap does not open hundreds of sockets. */
const MANIFEST_FETCH_CONCURRENCY = 6;

/**
 * `task` over every item with at most `limit` running at once, the results
 * in the items' order. A slot is refilled the moment it frees: unlike
 * fixed batches, one slow file holds up one slot, not the five beside it.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Candidate default branches tried before spending an API call on
 * `GET /repos/{owner}/{repo}`. The overwhelming majority of public repos
 * use one of these, so resolving the tree against them directly saves one
 * rate-limited API request per tap.
 */
const COMMON_DEFAULT_BRANCHES = ["main", "master"] as const;

/**
 * Resolve a working ref and list the tap's `SKILL.md` manifests using the
 * fewest API calls. Tries `main`/`master` directly; only falls back to the
 * `GET /repos` default-branch lookup when neither exists.
 */
async function resolveManifests(
  client: SkillHubClient,
  owner: string,
  repo: string,
  underDir: string,
): Promise<{ ref: string; manifests: RemoteSkillManifestRef[] }> {
  for (const ref of COMMON_DEFAULT_BRANCHES) {
    try {
      const manifests = await client.listSkillManifests(
        owner,
        repo,
        ref,
        underDir,
      );
      return { ref, manifests };
    } catch (err) {
      if (err instanceof GithubSkillError && err.code === "not_found") continue;
      throw err;
    }
  }
  const ref = await client.resolveDefaultBranch(owner, repo);
  const manifests = await client.listSkillManifests(owner, repo, ref, underDir);
  return { ref, manifests };
}

export async function browseTap(
  client: SkillHubClient,
  tap: SkillTap,
): Promise<HubSkillEntry[]> {
  const { owner, repo } = parseTapRepo(tap.repo);
  const { ref, manifests } = await resolveManifests(
    client,
    owner,
    repo,
    tap.path,
  );

  const resolved = await mapBounded(
    manifests,
    MANIFEST_FETCH_CONCURRENCY,
    async (m): Promise<HubSkillEntry | null> => {
      try {
        const content = await client.fetchTextFile(
          owner,
          repo,
          ref,
          m.manifestPath,
        );
        const { manifest } = parseSkillFile(content);
        return {
          identifier: formatSkillIdentifier(owner, repo, m.dir),
          name: manifest.name,
          description: manifest.description,
          version: manifest.version,
          repo: `${owner}/${repo}`,
          dir: m.dir,
          source: "github",
        };
      } catch {
        return null;
      }
    },
  );
  const entries = resolved.filter((e): e is HubSkillEntry => e !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Browse every tap and return the union, deduplicated by identifier.
 * Per-tap failures are collected into `errors` so one unreachable repo
 * does not blank the whole list. The taps are read side by side (each
 * with its own bounded fan-out) and merged in the configured order, so
 * the first tap still wins a duplicate and `errors` keeps that order.
 */
export async function browseHub(
  client: SkillHubClient,
  taps: readonly SkillTap[],
): Promise<{
  entries: HubSkillEntry[];
  errors: Array<{ repo: string; error: string }>;
}> {
  const results = await Promise.all(
    taps.map((tap) =>
      browseTap(client, tap).then(
        (tapEntries) => ({ tapEntries, error: null }),
        (err: unknown) => ({
          tapEntries: [] as HubSkillEntry[],
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    ),
  );
  const seen = new Set<string>();
  const entries: HubSkillEntry[] = [];
  const errors: Array<{ repo: string; error: string }> = [];
  results.forEach(({ tapEntries, error }, i) => {
    if (error !== null) {
      errors.push({ repo: taps[i]!.repo, error });
      return;
    }
    for (const e of tapEntries) {
      if (seen.has(e.identifier)) continue;
      seen.add(e.identifier);
      entries.push(e);
    }
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, errors };
}

/**
 * Pure, network-free substring filter (case-insensitive) over name +
 * description + identifier. An empty query returns a copy of the input.
 * Shared by {@link searchHub} and the TUI orchestrator's cached search so
 * the matching semantics stay identical.
 */
export function filterHubEntries(
  entries: readonly HubSkillEntry[],
  query: string,
): HubSkillEntry[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...entries];
  return entries.filter((e) =>
    `${e.name} ${e.description} ${e.identifier}`.toLowerCase().includes(q),
  );
}

/**
 * Substring search (case-insensitive) over name + description +
 * identifier across all taps. An empty query returns the full browse.
 */
export async function searchHub(
  client: SkillHubClient,
  taps: readonly SkillTap[],
  query: string,
): Promise<{
  entries: HubSkillEntry[];
  errors: Array<{ repo: string; error: string }>;
}> {
  const { entries, errors } = await browseHub(client, taps);
  return { entries: filterHubEntries(entries, query), errors };
}
