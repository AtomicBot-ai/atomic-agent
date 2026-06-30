import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

/**
 * The ONLY module that talks to GitHub. Resolves the default branch,
 * walks the repo tree to discover `SKILL.md` files, and downloads a
 * single skill directory into a destination dir. Everything goes
 * through an injectable `fetch` so tests never touch the network.
 */

export interface DownloadedSkillFile {
  /** Path relative to the skill directory root (POSIX separators). */
  relativePath: string;
  content: string;
}

export interface RemoteSkillManifestRef {
  /** Directory containing SKILL.md (repo-relative, POSIX, "" = root). */
  dir: string;
  /** Full repo-relative path to the SKILL.md blob. */
  manifestPath: string;
}

/**
 * Minimal surface the catalog / installer depend on. Implemented by
 * {@link GithubSkillClient}; stubbed in tests.
 */
export interface SkillHubClient {
  resolveDefaultBranch(owner: string, repo: string): Promise<string>;
  listSkillManifests(
    owner: string,
    repo: string,
    ref: string,
    underDir?: string,
  ): Promise<RemoteSkillManifestRef[]>;
  fetchTextFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<string>;
  downloadSkillDir(
    owner: string,
    repo: string,
    ref: string,
    dir: string,
    destDir: string,
  ): Promise<DownloadedSkillFile[]>;
}

export type GithubSkillErrorCode =
  | "not_found"
  | "rate_limited"
  | "network"
  | "too_large"
  | "unexpected";

export class GithubSkillError extends Error {
  constructor(
    message: string,
    public readonly code: GithubSkillErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GithubSkillError";
  }
}

export interface GithubSkillClientOptions {
  /** GitHub token for higher rate limits. Falls back to `GITHUB_TOKEN`. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  rawBase?: string;
  /** Hard caps so a malicious tree cannot exhaust disk. */
  maxFilesPerSkill?: number;
  maxTotalBytes?: number;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
}

export class GithubSkillClient implements SkillHubClient {
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly rawBase: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(options: GithubSkillClientOptions = {}) {
    this.token =
      options.token ?? process.env.GITHUB_TOKEN?.trim() ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    this.rawBase = (options.rawBase ?? DEFAULT_RAW_BASE).replace(/\/$/, "");
    this.maxFiles = options.maxFilesPerSkill ?? DEFAULT_MAX_FILES;
    this.maxBytes = options.maxTotalBytes ?? DEFAULT_MAX_BYTES;
  }

  async resolveDefaultBranch(owner: string, repo: string): Promise<string> {
    const res = await this.apiFetch(`/repos/${owner}/${repo}`);
    const body = (await res.json()) as { default_branch?: unknown };
    const branch =
      typeof body.default_branch === "string" ? body.default_branch : null;
    return branch && branch.length > 0 ? branch : "main";
  }

  async listSkillManifests(
    owner: string,
    repo: string,
    ref: string,
    underDir = "",
  ): Promise<RemoteSkillManifestRef[]> {
    const tree = await this.listTree(owner, repo, ref);
    const prefix = normalizeDir(underDir);
    const out: RemoteSkillManifestRef[] = [];
    for (const entry of tree) {
      if (entry.type !== "blob") continue;
      if (!isSkillManifestPath(entry.path)) continue;
      if (prefix && !entry.path.startsWith(`${prefix}/`)) continue;
      out.push({
        dir: skillDirOf(entry.path),
        manifestPath: entry.path,
      });
    }
    out.sort((a, b) => a.dir.localeCompare(b.dir));
    return out;
  }

  async fetchTextFile(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<string> {
    const url = `${this.rawBase}/${owner}/${repo}/${ref}/${path}`;
    const res = await this.rawFetch(url);
    return await res.text();
  }

  async downloadSkillDir(
    owner: string,
    repo: string,
    ref: string,
    dir: string,
    destDir: string,
  ): Promise<DownloadedSkillFile[]> {
    const tree = await this.listTree(owner, repo, ref);
    const prefix = normalizeDir(dir);
    const blobs = tree.filter(
      (e) =>
        e.type === "blob" &&
        (prefix === "" || e.path === prefix || e.path.startsWith(`${prefix}/`)),
    );
    if (blobs.length === 0) {
      throw new GithubSkillError(
        `no files found at ${owner}/${repo}/${prefix || "<root>"}`,
        "not_found",
      );
    }
    if (blobs.length > this.maxFiles) {
      throw new GithubSkillError(
        `skill has ${blobs.length} files, exceeding cap ${this.maxFiles}`,
        "too_large",
      );
    }

    const absDest = resolve(destDir);
    await mkdir(absDest, { recursive: true });
    const files: DownloadedSkillFile[] = [];
    let total = 0;
    for (const blob of blobs) {
      const relativePath =
        prefix === "" ? blob.path : blob.path.slice(prefix.length + 1);
      if (relativePath.length === 0) continue;
      const content = await this.fetchTextFile(owner, repo, ref, blob.path);
      total += Buffer.byteLength(content, "utf8");
      if (total > this.maxBytes) {
        throw new GithubSkillError(
          `skill exceeds size cap ${this.maxBytes} bytes`,
          "too_large",
        );
      }
      const target = resolve(absDest, relativePath);
      if (target !== absDest && !target.startsWith(absDest + sep)) {
        throw new GithubSkillError(
          `path traversal blocked: ${relativePath}`,
          "unexpected",
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      files.push({ relativePath: toPosix(relative(absDest, target)), content });
    }
    return files;
  }

  private async listTree(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitTreeEntry[]> {
    const res = await this.apiFetch(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    const body = (await res.json()) as { tree?: unknown };
    if (!Array.isArray(body.tree)) {
      throw new GithubSkillError(
        `unexpected tree response for ${owner}/${repo}@${ref}`,
        "unexpected",
      );
    }
    const entries: GitTreeEntry[] = [];
    for (const raw of body.tree) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.path !== "string") continue;
      const type = e.type;
      if (type === "blob" || type === "tree" || type === "commit") {
        entries.push({ path: e.path, type });
      }
    }
    return entries;
  }

  private async apiFetch(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "atomic-agent",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return this.guardedFetch(`${this.apiBase}${path}`, headers);
  }

  private async rawFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = { "User-Agent": "atomic-agent" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return this.guardedFetch(url, headers);
  }

  private async guardedFetch(
    url: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers });
    } catch (err) {
      throw new GithubSkillError(
        `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    if (res.ok) return res;
    if (res.status === 404) {
      throw new GithubSkillError(`not found: ${url}`, "not_found", 404);
    }
    if (
      res.status === 403 &&
      res.headers.get("x-ratelimit-remaining") === "0"
    ) {
      throw new GithubSkillError(
        "GitHub rate limit exceeded; set GITHUB_TOKEN to raise the limit",
        "rate_limited",
        403,
      );
    }
    throw new GithubSkillError(
      `GitHub request failed (${res.status}): ${url}`,
      "unexpected",
      res.status,
    );
  }
}

function isSkillManifestPath(path: string): boolean {
  return path === "SKILL.md" || path.endsWith("/SKILL.md");
}

function skillDirOf(manifestPath: string): string {
  const idx = manifestPath.lastIndexOf("/SKILL.md");
  return idx === -1 ? "" : manifestPath.slice(0, idx);
}

function normalizeDir(dir: string): string {
  return dir.replace(/^\/+|\/+$/g, "");
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
