import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubSkillClient, GithubSkillError } from "./github-skill-client.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

interface FakeRoutes {
  defaultBranch?: string;
  tree?: Array<{ path: string; type: "blob" | "tree" }>;
  files?: Record<string, string>;
  rateLimited?: boolean;
}

function makeFetch(routes: FakeRoutes): typeof fetch {
  return (async (url: string) => {
    if (routes.rateLimited) {
      return new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    }
    if (url === `${API}/repos/o/r`) {
      return jsonResponse({ default_branch: routes.defaultBranch ?? "main" });
    }
    if (url.startsWith(`${API}/repos/o/r/git/trees/`)) {
      return jsonResponse({ tree: routes.tree ?? [] });
    }
    if (url.startsWith(`${RAW}/o/r/`)) {
      const path = url.slice(`${RAW}/o/r/main/`.length);
      const content = routes.files?.[path];
      if (content === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(content, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GithubSkillClient", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await mkdtemp(join(tmpdir(), "atomic-gh-"));
  });

  afterEach(async () => {
    await rm(dest, { recursive: true, force: true });
  });

  it("resolves the default branch", async () => {
    const client = new GithubSkillClient({
      fetchImpl: makeFetch({ defaultBranch: "trunk" }),
    });
    expect(await client.resolveDefaultBranch("o", "r")).toBe("trunk");
  });

  it("lists SKILL.md manifests, scoped to a subdir", async () => {
    const client = new GithubSkillClient({
      fetchImpl: makeFetch({
        tree: [
          { path: "pdf/SKILL.md", type: "blob" },
          { path: "pdf/run.sh", type: "blob" },
          { path: "docs/SKILL.md", type: "blob" },
          { path: "README.md", type: "blob" },
        ],
      }),
    });
    const all = await client.listSkillManifests("o", "r", "main");
    expect(all.map((m) => m.dir)).toEqual(["docs", "pdf"]);

    const scoped = await client.listSkillManifests("o", "r", "main", "pdf");
    expect(scoped.map((m) => m.dir)).toEqual(["pdf"]);
  });

  it("downloads a skill dir, stripping the dir prefix", async () => {
    const client = new GithubSkillClient({
      fetchImpl: makeFetch({
        tree: [
          { path: "pdf/SKILL.md", type: "blob" },
          { path: "pdf/scripts/run.sh", type: "blob" },
          { path: "other/SKILL.md", type: "blob" },
        ],
        files: {
          "pdf/SKILL.md": "# pdf",
          "pdf/scripts/run.sh": "echo hi",
        },
      }),
    });
    const files = await client.downloadSkillDir("o", "r", "main", "pdf", dest);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    const written = await readFile(join(dest, "scripts", "run.sh"), "utf8");
    expect(written).toBe("echo hi");
  });

  it("throws not_found when the dir has no files", async () => {
    const client = new GithubSkillClient({
      fetchImpl: makeFetch({ tree: [{ path: "a/SKILL.md", type: "blob" }] }),
    });
    await expect(
      client.downloadSkillDir("o", "r", "main", "missing", dest),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps rate-limit 403 to a typed error", async () => {
    const client = new GithubSkillClient({
      fetchImpl: makeFetch({ rateLimited: true }),
    });
    await expect(client.resolveDefaultBranch("o", "r")).rejects.toBeInstanceOf(
      GithubSkillError,
    );
    await expect(client.resolveDefaultBranch("o", "r")).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("GithubSkillClient.resolveSkillRevision", () => {
  const COMMIT = "c".repeat(40);
  function revisionFetch(seen: string[]): typeof fetch {
    return (async (url: string) => {
      seen.push(url);
      if (url === `${API}/repos/o/r/commits/main`) {
        return jsonResponse({ sha: COMMIT, commit: { tree: { sha: "root-tree" } } });
      }
      if (url === `${API}/repos/o/r/git/trees/${COMMIT}?recursive=1`) {
        return jsonResponse({
          tree: [
            { path: "skills", type: "tree", sha: "skills-tree" },
            { path: "skills/pdf", type: "tree", sha: "pdf-tree" },
            { path: "skills/pdf/SKILL.md", type: "blob", sha: "blob" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("returns the commit and the skill folder's tree sha at that commit", async () => {
    const seen: string[] = [];
    const client = new GithubSkillClient({ fetchImpl: revisionFetch(seen), token: null });
    expect(await client.resolveSkillRevision("o", "r", "main", "skills/pdf")).toEqual({
      commit: COMMIT,
      tree: "pdf-tree",
    });
    // The tree is read at the resolved commit, not the moving branch.
    expect(seen).toContain(`${API}/repos/o/r/git/trees/${COMMIT}?recursive=1`);
  });

  it("uses the root tree for a skill at the repo root, and null for a missing folder", async () => {
    const client = new GithubSkillClient({ fetchImpl: revisionFetch([]), token: null });
    expect(await client.resolveSkillRevision("o", "r", "main", "")).toEqual({
      commit: COMMIT,
      tree: "root-tree",
    });
    expect(await client.resolveSkillRevision("o", "r", "main", "nope")).toEqual({
      commit: COMMIT,
      tree: null,
    });
  });

  it("rejects a commit response without a sha", async () => {
    const client = new GithubSkillClient({
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      token: null,
    });
    await expect(client.resolveSkillRevision("o", "r", "main", "x")).rejects.toBeInstanceOf(
      GithubSkillError,
    );
  });
});
