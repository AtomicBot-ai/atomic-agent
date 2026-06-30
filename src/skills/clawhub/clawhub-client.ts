/**
 * The ONLY module that talks to the ClawHub registry HTTP API
 * (https://clawhub.ai, public read endpoints under `/api/v1`). Everything
 * goes through an injectable `fetch` so tests never touch the network.
 *
 * Public read limits are generous (3000 req/min per IP) and require no
 * token, so — unlike the GitHub tap client — browse/search hit the API
 * live on every call instead of caching to dodge a 60/hour cap.
 */

export type ClawHubScanStatus = "clean" | "suspicious" | "malicious" | "unknown";

export type ClawHubSkillSort =
  | "recommended"
  | "downloads"
  | "trending"
  | "updated"
  | "createdAt"
  | "stars";

/** Compact catalog row from `/skills` (browse) or `/search`. */
export interface ClawHubSkillSummary {
  slug: string;
  /** Publisher handle. `null` on browse rows — the API omits it there. */
  ownerHandle: string | null;
  displayName: string;
  summary: string;
  version: string;
  /** All-time download count (`stats.downloads` / `downloads`), 0 if absent. */
  downloads: number;
}

/** Full skill detail from `/skills/:slug` — carries the raw SKILL.md. */
export interface ClawHubSkillDetail {
  slug: string;
  ownerHandle: string | null;
  displayName: string;
  summary: string;
  version: string;
  downloads: number;
  /** Raw SKILL.md (frontmatter + body) as published, or "" when absent. */
  skillMd: string;
}

export type ClawHubErrorCode =
  | "not_found"
  | "ambiguous"
  | "rate_limited"
  | "network"
  | "unexpected";

export class ClawHubError extends Error {
  constructor(
    message: string,
    public readonly code: ClawHubErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ClawHubError";
  }
}

export interface ClawHubClientOptions {
  /** API base URL. Defaults to `https://clawhub.ai`. */
  apiBase?: string;
  /** Optional Bearer token (raises per-user rate limits). */
  token?: string | null;
  fetchImpl?: typeof fetch;
  /** Hard cap on a downloaded skill ZIP. */
  maxDownloadBytes?: number;
}

export interface BrowseOptions {
  limit?: number;
  sort?: ClawHubSkillSort;
  nonSuspiciousOnly?: boolean;
  cursor?: string | null;
}

export interface SearchOptions {
  query: string;
  limit?: number;
  nonSuspiciousOnly?: boolean;
}

export interface DownloadOptions {
  slug: string;
  owner?: string | null;
  tag?: string;
  version?: string;
}

const DEFAULT_API_BASE = "https://clawhub.ai";
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export class ClawHubClient {
  private readonly apiBase: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly maxDownloadBytes: number;

  constructor(options: ClawHubClientOptions = {}) {
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.token = options.token ?? process.env.CLAWHUB_TOKEN?.trim() ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxDownloadBytes =
      options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  }

  /** Browse the catalog (popular by default). One API call. */
  async browse(
    options: BrowseOptions = {},
  ): Promise<{ items: ClawHubSkillSummary[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 100));
    params.set("sort", options.sort ?? "recommended");
    if (options.nonSuspiciousOnly) params.set("nonSuspiciousOnly", "true");
    if (options.cursor) params.set("cursor", options.cursor);
    const res = await this.apiFetch(`/api/v1/skills?${params.toString()}`);
    const body = (await res.json()) as {
      items?: unknown;
      nextCursor?: unknown;
    };
    const items = Array.isArray(body.items)
      ? body.items.map(toSummaryFromBrowse).filter((s): s is ClawHubSkillSummary => s !== null)
      : [];
    const nextCursor =
      typeof body.nextCursor === "string" ? body.nextCursor : null;
    return { items, nextCursor };
  }

  /** Relevance search. One API call. */
  async search(options: SearchOptions): Promise<ClawHubSkillSummary[]> {
    const params = new URLSearchParams();
    params.set("q", options.query);
    params.set("limit", String(options.limit ?? 50));
    if (options.nonSuspiciousOnly) params.set("nonSuspiciousOnly", "true");
    const res = await this.apiFetch(`/api/v1/search?${params.toString()}`);
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) return [];
    return body.results
      .map(toSummaryFromSearch)
      .filter((s): s is ClawHubSkillSummary => s !== null);
  }

  /**
   * Fetch full skill detail (incl. the raw SKILL.md) without downloading
   * the version ZIP — the lightweight source for the pre-install card.
   * `owner` disambiguates a slug shared by multiple publishers; omitting
   * it on an ambiguous slug surfaces a `ClawHubError` with code
   * `"ambiguous"` that the caller renders as "preview unavailable".
   */
  async getSkillDetail(opts: {
    slug: string;
    owner?: string | null;
  }): Promise<ClawHubSkillDetail> {
    const params = new URLSearchParams();
    if (opts.owner) params.set("owner", opts.owner);
    const qs = params.toString();
    const res = await this.apiFetch(
      `/api/v1/skills/${encodeURIComponent(opts.slug)}${qs ? `?${qs}` : ""}`,
    );
    const body = (await res.json()) as { skill?: unknown };
    const detail = toDetail(body.skill);
    if (!detail) {
      throw new ClawHubError(
        `unexpected skill detail shape for ${opts.slug}`,
        "unexpected",
      );
    }
    return detail;
  }

  /**
   * Fetch the ClawScan verdict for a skill version. Returns `"unknown"`
   * when the registry has no definitive scan result, so callers can fall
   * back to the local heuristic scanner without sniffing error shapes.
   */
  async getScanStatus(opts: {
    slug: string;
    owner?: string | null;
    version?: string;
    tag?: string;
  }): Promise<ClawHubScanStatus> {
    const params = new URLSearchParams();
    if (opts.owner) params.set("owner", opts.owner);
    if (opts.version) params.set("version", opts.version);
    if (opts.tag) params.set("tag", opts.tag);
    const qs = params.toString();
    let res: Response;
    try {
      res = await this.apiFetch(
        `/api/v1/skills/${encodeURIComponent(opts.slug)}/scan${qs ? `?${qs}` : ""}`,
      );
    } catch {
      return "unknown";
    }
    const body = (await res.json()) as {
      security?: { status?: unknown; hasScanResult?: unknown };
    };
    const status = body.security?.status;
    if (
      status === "clean" ||
      status === "suspicious" ||
      status === "malicious"
    ) {
      return status;
    }
    return "unknown";
  }

  /** Download the skill version ZIP as a Buffer. */
  async downloadZip(opts: DownloadOptions): Promise<Buffer> {
    const params = new URLSearchParams();
    params.set("slug", opts.slug);
    if (opts.owner) params.set("owner", opts.owner);
    if (opts.version) params.set("version", opts.version);
    else params.set("tag", opts.tag ?? "latest");
    const res = await this.apiFetch(
      `/api/v1/download?${params.toString()}`,
    );
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("zip")) {
      // GitHub-backed skills with no hosted version return a JSON handoff.
      throw new ClawHubError(
        `skill ${opts.slug} has no hosted ZIP (source handoff not supported)`,
        "unexpected",
      );
    }
    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength > this.maxDownloadBytes) {
      throw new ClawHubError(
        `skill ZIP exceeds size cap ${this.maxDownloadBytes} bytes`,
        "unexpected",
      );
    }
    return Buffer.from(arrayBuf);
  }

  private async apiFetch(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "atomic-agent",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const url = `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      throw new ClawHubError(
        `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    if (res.ok) return res;
    if (res.status === 404) {
      throw new ClawHubError(`not found: ${url}`, "not_found", 404);
    }
    if (res.status === 409) {
      throw new ClawHubError(
        "ambiguous skill slug — install via @owner/slug (use search to resolve the owner)",
        "ambiguous",
        409,
      );
    }
    if (res.status === 429) {
      throw new ClawHubError(
        "ClawHub rate limit exceeded; retry shortly",
        "rate_limited",
        429,
      );
    }
    throw new ClawHubError(
      `ClawHub request failed (${res.status}): ${url}`,
      "unexpected",
      res.status,
    );
  }
}

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

/**
 * Resolve the all-time download count. Browse rows nest it under
 * `stats.downloads`; search rows expose a flat `downloads`. Missing or
 * non-numeric values collapse to 0 so sort/render never see NaN.
 */
function resolveDownloads(o: Record<string, unknown>): number {
  if (typeof o.downloads === "number" && Number.isFinite(o.downloads)) {
    return o.downloads;
  }
  const stats = o.stats as { downloads?: unknown } | undefined;
  if (typeof stats?.downloads === "number" && Number.isFinite(stats.downloads)) {
    return stats.downloads;
  }
  return 0;
}

function toSummaryFromBrowse(raw: unknown): ClawHubSkillSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string") return null;
  return {
    slug: o.slug,
    ownerHandle: typeof o.ownerHandle === "string" ? o.ownerHandle : null,
    displayName: typeof o.displayName === "string" ? o.displayName : o.slug,
    summary: typeof o.summary === "string" ? o.summary : "",
    version: resolveVersion(o),
    downloads: resolveDownloads(o),
  };
}

function toSummaryFromSearch(raw: unknown): ClawHubSkillSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string") return null;
  return {
    slug: o.slug,
    ownerHandle: typeof o.ownerHandle === "string" ? o.ownerHandle : null,
    displayName: typeof o.displayName === "string" ? o.displayName : o.slug,
    summary: typeof o.summary === "string" ? o.summary : "",
    version: resolveVersion(o),
    downloads: resolveDownloads(o),
  };
}

function toDetail(raw: unknown): ClawHubSkillDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string") return null;
  // `/skills/:slug` returns the raw SKILL.md in `description`.
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
