import { describe, expect, it } from "vitest";
import {
  GithubSkillError,
  type DownloadedSkillFile,
  type RemoteSkillManifestRef,
  type SkillHubClient,
} from "./github-skill-client.js";
import { browseHub, browseTap, searchHub } from "./skill-hub-catalog.js";

function manifest(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: "${description}"`,
    "version: 1.0.0",
    "---",
    "# body",
  ].join("\n");
}

class FakeClient implements SkillHubClient {
  constructor(
    private readonly skills: Record<string, { dir: string; content: string }[]>,
  ) {}

  async resolveDefaultBranch(): Promise<string> {
    return "main";
  }

  async listSkillManifests(
    owner: string,
    repo: string,
  ): Promise<RemoteSkillManifestRef[]> {
    const list = this.skills[`${owner}/${repo}`] ?? [];
    return list.map((s) => ({
      dir: s.dir,
      manifestPath: s.dir ? `${s.dir}/SKILL.md` : "SKILL.md",
    }));
  }

  async fetchTextFile(
    owner: string,
    repo: string,
    _ref: string,
    path: string,
  ): Promise<string> {
    const list = this.skills[`${owner}/${repo}`] ?? [];
    const found = list.find(
      (s) => (s.dir ? `${s.dir}/SKILL.md` : "SKILL.md") === path,
    );
    if (!found) throw new Error(`no file ${path}`);
    return found.content;
  }

  async downloadSkillDir(): Promise<DownloadedSkillFile[]> {
    throw new Error("not used");
  }
}

describe("browseTap", () => {
  it("parses each SKILL.md into a catalog entry", async () => {
    const client = new FakeClient({
      "anthropics/skills": [
        { dir: "pdf", content: manifest("pdf", "Work with PDFs") },
        { dir: "docx", content: manifest("docx", "Work with Word docs") },
      ],
    });
    const entries = await browseTap(client, {
      repo: "anthropics/skills",
      path: "",
    });
    expect(entries.map((e) => e.identifier)).toEqual([
      "anthropics/skills/docx",
      "anthropics/skills/pdf",
    ]);
    expect(entries[1].description).toBe("Work with PDFs");
  });

  it("skips a malformed manifest without failing the browse", async () => {
    const client = new FakeClient({
      "o/r": [
        { dir: "good", content: manifest("good", "ok") },
        { dir: "bad", content: "not a manifest" },
      ],
    });
    const entries = await browseTap(client, { repo: "o/r", path: "" });
    expect(entries.map((e) => e.name)).toEqual(["good"]);
  });
});

describe("browseHub / searchHub", () => {
  const client = new FakeClient({
    "openai/skills": [{ dir: "k8s", content: manifest("k8s", "Kubernetes ops") }],
    "anthropics/skills": [
      { dir: "pdf", content: manifest("pdf", "Work with PDFs") },
    ],
  });
  const taps = [
    { repo: "openai/skills", path: "" },
    { repo: "anthropics/skills", path: "" },
  ];

  it("merges taps", async () => {
    const { entries } = await browseHub(client, taps);
    expect(entries.map((e) => e.name)).toEqual(["k8s", "pdf"]);
  });

  it("filters by query", async () => {
    const { entries } = await searchHub(client, taps, "kubernetes");
    expect(entries.map((e) => e.name)).toEqual(["k8s"]);
  });

  it("collects per-tap errors instead of throwing", async () => {
    // A non-`not_found` failure (e.g. rate limit) on listSkillManifests
    // propagates and is collected per-tap rather than aborting the browse.
    const failing: SkillHubClient = {
      resolveDefaultBranch: async () => "main",
      listSkillManifests: async () => {
        throw new GithubSkillError("rate limited", "rate_limited", 403);
      },
      fetchTextFile: async () => "",
      downloadSkillDir: async () => [],
    };
    const { entries, errors } = await browseHub(failing, [
      { repo: "x/y", path: "" },
    ]);
    expect(entries).toEqual([]);
    expect(errors[0]).toMatchObject({ repo: "x/y" });
  });
});

describe("browseTap lazy branch resolution", () => {
  it("falls back to master when main is not found, without GET /repos", async () => {
    let resolveDefaultCalls = 0;
    const refsTried: string[] = [];
    const client: SkillHubClient = {
      resolveDefaultBranch: async () => {
        resolveDefaultCalls += 1;
        return "main";
      },
      listSkillManifests: async (_owner, _repo, ref) => {
        refsTried.push(ref);
        if (ref === "main") {
          throw new GithubSkillError("not found", "not_found", 404);
        }
        return [{ dir: "pdf", manifestPath: "pdf/SKILL.md" }];
      },
      fetchTextFile: async () => manifest("pdf", "Work with PDFs"),
      downloadSkillDir: async () => [],
    };
    const entries = await browseTap(client, { repo: "o/r", path: "" });
    expect(entries.map((e) => e.name)).toEqual(["pdf"]);
    expect(refsTried).toEqual(["main", "master"]);
    expect(resolveDefaultCalls).toBe(0);
  });

  it("resolves the default branch only when neither main nor master exist", async () => {
    let resolveDefaultCalls = 0;
    const client: SkillHubClient = {
      resolveDefaultBranch: async () => {
        resolveDefaultCalls += 1;
        return "trunk";
      },
      listSkillManifests: async (_owner, _repo, ref) => {
        if (ref === "main" || ref === "master") {
          throw new GithubSkillError("not found", "not_found", 404);
        }
        return [{ dir: "pdf", manifestPath: "pdf/SKILL.md" }];
      },
      fetchTextFile: async () => manifest("pdf", "Work with PDFs"),
      downloadSkillDir: async () => [],
    };
    const entries = await browseTap(client, { repo: "o/r", path: "" });
    expect(entries.map((e) => e.name)).toEqual(["pdf"]);
    expect(resolveDefaultCalls).toBe(1);
  });
});
