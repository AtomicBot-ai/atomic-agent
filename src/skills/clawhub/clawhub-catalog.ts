import type { HubSkillEntry } from "../hub/skill-hub-catalog.js";
import {
  type BrowseOptions,
  type ClawHubClient,
  type ClawHubSkillSummary,
} from "./clawhub-client.js";
import { formatClawHubIdentifier } from "./clawhub-source.js";

/**
 * Discovery layer over {@link ClawHubClient}. Maps the registry's
 * browse/search rows into the shared {@link HubSkillEntry} shape so the
 * TUI and CLI render ClawHub and GitHub results through one code path.
 */

function toEntry(summary: ClawHubSkillSummary): HubSkillEntry {
  return {
    identifier: formatClawHubIdentifier(summary.ownerHandle, summary.slug),
    name: summary.displayName || summary.slug,
    description: summary.summary,
    version: summary.version,
    repo: summary.ownerHandle ?? "clawhub",
    dir: "",
    source: "clawhub",
    downloads: summary.downloads,
  };
}

/** Most-downloaded first; ties keep the upstream (relevance) order. */
function byDownloadsDesc(a: HubSkillEntry, b: HubSkillEntry): number {
  return (b.downloads ?? 0) - (a.downloads ?? 0);
}

export interface ClawHubBrowseOptions extends BrowseOptions {}

/** Browse the ClawHub catalog (popular by default) → catalog rows. */
export async function browseClawHub(
  client: ClawHubClient,
  options: ClawHubBrowseOptions = {},
): Promise<HubSkillEntry[]> {
  const { items } = await client.browse(options);
  return items.map(toEntry);
}

/**
 * Search ClawHub → catalog rows, sorted by download count (descending).
 * The `/search` endpoint ranks by relevance and ignores a `sort` param,
 * so the most-installed match is reordered to the top client-side; ties
 * preserve the server's relevance order (stable sort).
 */
export async function searchClawHub(
  client: ClawHubClient,
  query: string,
  options: { limit?: number; nonSuspiciousOnly?: boolean } = {},
): Promise<HubSkillEntry[]> {
  const results = await client.search({ query, ...options });
  return results.map(toEntry).sort(byDownloadsDesc);
}
