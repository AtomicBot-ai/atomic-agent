import { describe, expect, it, vi } from "vitest";
import {
  formatSkillsShIdentifier,
  looksLikeSkillsShIdentifier,
  parseSkillsShResponse,
  searchSkillsSh,
  SkillsShClient,
  SkillsShError,
} from "./skills-sh-client.js";

/** Shape seen from `GET https://skills.sh/api/search?q=pdf`. */
const BODY = {
  query: "pdf",
  searchType: "fuzzy",
  skills: [
    { id: "openai/skills/pdf", source: "openai/skills", skillId: "pdf", name: "pdf", installs: 13788 },
    { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 227931 },
    { id: "x/y/chat-with-pdf", source: "x/y", skillId: "chat-with-pdf", name: "Chat with PDF", installs: 4957 },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(impl: () => Promise<Response>) {
  const fetchImpl = vi.fn(impl);
  return { fetchImpl, client: new SkillsShClient({ fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("parseSkillsShResponse", () => {
  it("maps rows to owner, repo, skill id, name and installs", () => {
    expect(parseSkillsShResponse(BODY)[1]).toEqual({ owner: "anthropics", repo: "skills", skillId: "pdf", name: "pdf", installs: 227931 });
  });

  it("skips malformed rows and keeps the rest", () => {
    const rows = parseSkillsShResponse({ skills: [
      null, "x", { source: "no-slash", skillId: "a" }, { source: "a/b/c", skillId: "a" },
      { source: "o/r", skillId: "../escape" }, { source: "o/r", skillId: "a/b" }, { source: "-bad/r", skillId: "a" },
      { source: "o/r", skillId: "ok", name: 5, installs: "many" },
      { source: "o/r", skillId: "neg", installs: -3 },
    ] });
    expect(rows).toEqual([
      { owner: "o", repo: "r", skillId: "ok", name: "ok", installs: 0 },
      { owner: "o", repo: "r", skillId: "neg", name: "neg", installs: 0 },
    ]);
  });

  it("throws on a wrong top-level shape", () => {
    for (const body of [null, [], {}, { skills: "nope" }, { results: [] }]) {
      expect(() => parseSkillsShResponse(body)).toThrow(SkillsShError);
    }
  });
});

describe("SkillsShClient.search", () => {
  it("encodes the query and caps the result count", async () => {
    const { client, fetchImpl } = clientWith(async () => json(BODY));
    const rows = await client.search("pdf & docs", 2);
    expect(rows).toHaveLength(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://skills.sh/api/search?q=pdf%20%26%20docs");
  });

  it("throws on HTTP errors and non-JSON bodies", async () => {
    await expect(clientWith(async () => json({}, 500)).client.search("x")).rejects.toThrow(/500/);
    await expect(clientWith(async () => new Response("<html>", { status: 200 })).client.search("x")).rejects.toThrow(/not JSON/);
  });
});

describe("searchSkillsSh", () => {
  it("returns hub rows, most installed first, with installable identifiers", async () => {
    const warn = vi.fn();
    const rows = await searchSkillsSh(clientWith(async () => json(BODY)).client, "pdf", { warn });
    expect(rows.map((r) => r.identifier)).toEqual([
      "skills.sh/anthropics/skills/pdf", "skills.sh/openai/skills/pdf", "skills.sh/x/y/chat-with-pdf",
    ]);
    expect(rows[0]).toMatchObject({ source: "skills.sh", repo: "anthropics/skills", downloads: 227931, name: "pdf" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("degrades every failure to no rows plus a warning", async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => json({}, 503),
      async () => new Response("not json", { status: 200 }),
      async () => json({ unexpected: true }),
    ];
    for (const impl of failures) {
      const warn = vi.fn();
      await expect(searchSkillsSh(clientWith(impl).client, "pdf", { warn })).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^skills\.sh search unavailable: /));
    }
  });

  it("does not call the network for an empty query", async () => {
    const { client, fetchImpl } = clientWith(async () => json(BODY));
    expect(await searchSkillsSh(client, "  ", { warn: vi.fn() })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drops duplicate rows", async () => {
    const dup = { skills: [BODY.skills[0], BODY.skills[0]] };
    expect(await searchSkillsSh(clientWith(async () => json(dup)).client, "pdf", { warn: vi.fn() })).toHaveLength(1);
  });
});

describe("skills.sh identifiers", () => {
  it("formats and recognises the skills.sh/ prefix", () => {
    expect(formatSkillsShIdentifier("o", "r", "s")).toBe("skills.sh/o/r/s");
    expect(looksLikeSkillsShIdentifier(" skills.sh/o/r/s")).toBe(true);
    expect(looksLikeSkillsShIdentifier("o/r/s")).toBe(false);
    expect(looksLikeSkillsShIdentifier("@o/s")).toBe(false);
  });
});
