import { describe, expect, it, vi } from "vitest";
import { ClawHubClient, ClawHubError } from "./clawhub-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("ClawHubClient.browse", () => {
  it("maps browse rows and forwards filter params", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/api/v1/skills?");
      expect(String(url)).toContain("nonSuspiciousOnly=true");
      expect(String(url)).toContain("sort=recommended");
      return jsonResponse({
        items: [
          {
            slug: "pdf-tools",
            ownerHandle: "alice",
            displayName: "PDF Tools",
            summary: "Work with PDFs",
            latestVersion: { version: "1.2.0" },
            stats: { downloads: 4242 },
          },
          { not: "a skill" },
        ],
        nextCursor: "abc",
      });
    });
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const { items, nextCursor } = await client.browse({
      nonSuspiciousOnly: true,
    });
    expect(nextCursor).toBe("abc");
    expect(items).toEqual([
      {
        slug: "pdf-tools",
        ownerHandle: "alice",
        displayName: "PDF Tools",
        summary: "Work with PDFs",
        version: "1.2.0",
        downloads: 4242,
      },
    ]);
  });
});

describe("ClawHubClient.search", () => {
  it("maps search results", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/api/v1/search?");
      expect(String(url)).toContain("q=pdf");
      return jsonResponse({
        results: [
          {
            slug: "pdf",
            ownerHandle: "bob",
            displayName: "PDF",
            summary: "pdf stuff",
            version: null,
            downloads: 43002,
          },
        ],
      });
    });
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await client.search({ query: "pdf" });
    expect(results).toHaveLength(1);
    expect(results[0]?.slug).toBe("pdf");
    expect(results[0]?.downloads).toBe(43002);
    // A null hosted version collapses to the "0.0.0" placeholder.
    expect(results[0]?.version).toBe("0.0.0");
  });
});

describe("ClawHubClient.getSkillDetail", () => {
  it("returns the raw SKILL.md from the detail endpoint", async () => {
    const skillMd = "---\nname: pdf\n---\n# PDF\nbody";
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/api/v1/skills/pdf");
      expect(String(url)).toContain("owner=awspace");
      return jsonResponse({
        skill: {
          slug: "pdf",
          displayName: "Pdf",
          summary: "pdf toolkit",
          description: skillMd,
          owner: { handle: "awspace" },
          stats: { downloads: 43002 },
          latestVersion: { version: "3.0.0" },
        },
      });
    });
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const detail = await client.getSkillDetail({ slug: "pdf", owner: "awspace" });
    expect(detail.skillMd).toBe(skillMd);
    expect(detail.ownerHandle).toBe("awspace");
    expect(detail.downloads).toBe(43002);
    expect(detail.version).toBe("3.0.0");
  });

  it("maps a 409 to an 'ambiguous' error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("conflict", { status: 409 }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.getSkillDetail({ slug: "pdf" }),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });
});

describe("ClawHubClient.getScanStatus", () => {
  it("returns the registry verdict", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ security: { status: "malicious" } }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.getScanStatus({ slug: "x" })).toBe("malicious");
  });

  it("falls back to 'unknown' on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.getScanStatus({ slug: "x" })).toBe("unknown");
  });
});

describe("ClawHubClient.downloadZip", () => {
  it("returns the ZIP buffer", async () => {
    const payload = Buffer.from("PK\u0003\u0004zip");
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain("/api/v1/download?");
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    });
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const buf = await client.downloadZip({ slug: "x", tag: "latest" });
    expect(buf.equals(payload)).toBe(true);
  });

  it("throws when the response is a non-ZIP handoff", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ source: "github" }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.downloadZip({ slug: "x" })).rejects.toBeInstanceOf(
      ClawHubError,
    );
  });

  it("enforces the size cap", async () => {
    const big = Buffer.alloc(64);
    const fetchImpl = vi.fn(async () =>
      new Response(big, {
        status: 200,
        headers: { "content-type": "application/zip" },
      }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxDownloadBytes: 16,
    });
    await expect(client.downloadZip({ slug: "x" })).rejects.toBeInstanceOf(
      ClawHubError,
    );
  });
});

describe("ClawHubClient error mapping", () => {
  it("maps 409 to an 'ambiguous' error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("conflict", { status: 409 }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.browse()).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("maps 429 to a 'rate_limited' error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("slow down", { status: 429 }),
    );
    const client = new ClawHubClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.browse()).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});
