/**
 * Item 7 part B (Skills tab): the Skills Hub card body. The TUI fetches
 * it from ClawHub's detail endpoint before anything is downloaded
 * (src/tui/skills/skills-orchestrator.ts openHubCard →
 * src/skills/clawhub/clawhub-client.ts getSkillDetail). The renderer
 * cannot fetch (CSP connect-src 'none'), so the request is made here,
 * with the client's headers and its error texts.
 */

export interface ClawHubDetail {
  slug: string;
  ownerHandle: string | null;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  /** Raw SKILL.md as published, "" when absent (`description` on the wire). */
  skillMd: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

function resolveVersion(o: Record<string, unknown>): string {
  const latest = o.latestVersion as { version?: unknown } | undefined;
  const tags = o.tags as { latest?: unknown } | undefined;
  return (
    (typeof o.version === "string" && o.version) ||
    (typeof latest?.version === "string" && latest.version) ||
    (typeof tags?.latest === "string" && tags.latest) ||
    "0.0.0"
  );
}

function resolveDownloads(o: Record<string, unknown>): number {
  if (typeof o.downloads === "number" && Number.isFinite(o.downloads)) return o.downloads;
  const stats = o.stats as { downloads?: unknown } | undefined;
  if (typeof stats?.downloads === "number" && Number.isFinite(stats.downloads)) return stats.downloads;
  return 0;
}

function toDetail(raw: unknown): ClawHubDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string") return null;
  const ownerObj = o.owner as { handle?: unknown } | undefined;
  const ownerHandle =
    (typeof o.ownerHandle === "string" && o.ownerHandle) ||
    (typeof ownerObj?.handle === "string" && ownerObj.handle) ||
    null;
  return {
    slug: o.slug,
    ownerHandle,
    displayName: typeof o.displayName === "string" ? o.displayName : o.slug,
    summary: typeof o.summary === "string" ? o.summary : "",
    version: resolveVersion(o),
    downloads: resolveDownloads(o),
    skillMd: typeof o.description === "string" ? o.description : "",
  };
}

export async function clawhubSkillDetail(
  apiBase: string,
  slug: string,
  owner: string | null,
): Promise<{ ok: boolean; detail?: ClawHubDetail; error?: string }> {
  if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(apiBase)) return { ok: false, error: `not an api base: ${apiBase}` };
  if (!SLUG_RE.test(slug)) return { ok: false, error: `invalid clawhub slug: ${slug}` };
  if (owner !== null && !OWNER_RE.test(owner)) return { ok: false, error: `invalid clawhub owner: ${owner}` };
  const params = new URLSearchParams();
  if (owner) params.set("owner", owner);
  const qs = params.toString();
  const url = `${apiBase.replace(/\/+$/, "")}/api/v1/skills/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "atomic-agent" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, error: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    if (res.status === 404) return { ok: false, error: `not found: ${url}` };
    if (res.status === 409) return { ok: false, error: "ambiguous skill slug — install via @owner/slug (use search to resolve the owner)" };
    if (res.status === 429) return { ok: false, error: "ClawHub rate limit exceeded; retry shortly" };
    return { ok: false, error: `ClawHub request failed (${res.status}): ${url}` };
  }
  let body: { skill?: unknown };
  try {
    body = (await res.json()) as { skill?: unknown };
  } catch (err) {
    return { ok: false, error: `ClawHub answered with no JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const detail = toDetail(body.skill);
  if (!detail) return { ok: false, error: `unexpected skill detail shape for ${slug}` };
  return { ok: true, detail };
}
