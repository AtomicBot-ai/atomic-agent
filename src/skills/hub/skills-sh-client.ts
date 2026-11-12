import type { HubSkillEntry } from "./skill-hub-catalog.js";

/**
 * The ONLY module that talks to the skills.sh directory
 * (https://skills.sh, the `npx skills` leaderboard). Its search endpoint
 * is undocumented, so every response is validated by hand and anything
 * unexpected degrades to "no results" through {@link searchSkillsSh}.
 * skills.sh only indexes GitHub repositories; installing one of its rows
 * goes through the GitHub client and the security scan
 * (see `skills-sh-install.ts`).
 */

export const SKILLS_SH_API_BASE = "https://skills.sh";

/** Identifier prefix that routes an install through skills.sh resolution. */
export const SKILLS_SH_PREFIX = "skills.sh/";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 25;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SKILL_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

export interface SkillsShSkill {
  owner: string;
  repo: string;
  /** skills.sh's skill id: the skill folder name, not its path in the repo. */
  skillId: string;
  name: string;
  installs: number;
}

export class SkillsShError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsShError";
  }
}

export interface SkillsShClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class SkillsShClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SkillsShClientOptions = {}) {
    this.apiBase = (options.apiBase ?? SKILLS_SH_API_BASE).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Search skills.sh. Throws {@link SkillsShError} on network or shape errors. */
  async search(query: string, limit = DEFAULT_LIMIT): Promise<SkillsShSkill[]> {
    const url = `${this.apiBase}/api/search?q=${encodeURIComponent(query)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": "atomic-agent" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SkillsShError(`network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new SkillsShError(`search failed (${res.status})`);
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new SkillsShError("search response too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SkillsShError("search response is not JSON");
    }
    return parseSkillsShResponse(body).slice(0, Math.max(0, limit));
  }
}

/**
 * Validate a `/api/search` body: `{ skills: [{ source: "owner/repo",
 * skillId, name, installs }] }`. A wrong top-level shape throws; a
 * malformed row is skipped so one bad entry never hides the rest.
 */
export function parseSkillsShResponse(body: unknown): SkillsShSkill[] {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { skills?: unknown }).skills)) {
    throw new SkillsShError("unexpected search response shape");
  }
  const out: SkillsShSkill[] = [];
  for (const raw of (body as { skills: unknown[] }).skills) {
    const row = parseRow(raw);
    if (row) out.push(row);
  }
  return out;
}

function parseRow(raw: unknown): SkillsShSkill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.source !== "string" || typeof r.skillId !== "string") return null;
  const parts = r.source.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  if (!SKILL_ID_RE.test(r.skillId) || r.skillId === "." || r.skillId === "..") return null;
  const name = typeof r.name === "string" && r.name.trim().length > 0 ? r.name.trim().slice(0, 200) : r.skillId;
  const installs = typeof r.installs === "number" && Number.isFinite(r.installs) && r.installs >= 0 ? Math.floor(r.installs) : 0;
  return { owner, repo, skillId: r.skillId, name, installs };
}

export function formatSkillsShIdentifier(owner: string, repo: string, skillId: string): string {
  return `${SKILLS_SH_PREFIX}${owner}/${repo}/${skillId}`;
}

export function looksLikeSkillsShIdentifier(raw: string): boolean {
  return raw.trim().startsWith(SKILLS_SH_PREFIX);
}

function toEntry(skill: SkillsShSkill): HubSkillEntry {
  return {
    identifier: formatSkillsShIdentifier(skill.owner, skill.repo, skill.skillId),
    name: skill.name,
    description: `${skill.owner}/${skill.repo} on skills.sh`,
    version: "",
    repo: `${skill.owner}/${skill.repo}`,
    dir: skill.skillId,
    source: "skills.sh",
    downloads: skill.installs,
  };
}

/**
 * skills.sh search as catalog rows, most installed first. Soft by
 * design: any failure is reported through `warn` and yields no rows,
 * so the other hub sources still render.
 */
export async function searchSkillsSh(
  client: Pick<SkillsShClient, "search">,
  query: string,
  options: { limit?: number; warn: (message: string) => void },
): Promise<HubSkillEntry[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  try {
    const skills = await client.search(q, options.limit ?? DEFAULT_LIMIT);
    const seen = new Set<string>();
    const entries: HubSkillEntry[] = [];
    for (const entry of skills.map(toEntry)) {
      if (seen.has(entry.identifier)) continue;
      seen.add(entry.identifier);
      entries.push(entry);
    }
    // Stable sort: ties keep the server's relevance order.
    return entries.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
  } catch (err) {
    options.warn(`skills.sh search unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
