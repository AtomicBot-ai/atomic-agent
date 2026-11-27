import { describe, expect, it, vi } from "vitest";

import { LinearApi, fitCommentBody, linearAuthHeader } from "./linear-api.js";

function fakeFetch(respond: (body: { query: string; variables: Record<string, unknown> }) => Response) {
  return vi.fn(async (_url: string, init: RequestInit) => respond(JSON.parse(String(init.body))));
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("LinearApi.createComment", () => {
  it("sends commentCreate with issueId, body and parentId to the GraphQL endpoint", async () => {
    const f = fakeFetch(() => ok({ commentCreate: { success: true, comment: { id: "c-new" } } }));
    const api = new LinearApi({ apiKey: "lin_api_abc123", fetchImpl: f as unknown as typeof fetch });
    const id = await api.createComment({ issueId: "issue-1", parentId: "c-root" }, "Done, see the PR.");
    expect(id).toBe("c-new");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_abc123");
    const sent = JSON.parse(String(init.body)) as { query: string; variables: { input: Record<string, string> } };
    expect(sent.query).toContain("commentCreate(input: $input)");
    expect(sent.query).toContain("CommentCreateInput!");
    expect(sent.variables).toEqual({ input: { issueId: "issue-1", body: "Done, see the PR.", parentId: "c-root" } });
  });

  it("leaves parentId out for a top-level comment", async () => {
    const f = fakeFetch(() => ok({ commentCreate: { success: true, comment: { id: "c2" } } }));
    await new LinearApi({ apiKey: "k", fetchImpl: f as unknown as typeof fetch }).createComment({ issueId: "i" }, "hi");
    const sent = JSON.parse(String(f.mock.calls[0]![1].body)) as { variables: { input: Record<string, string> } };
    expect(sent.variables.input).toEqual({ issueId: "i", body: "hi" });
  });

  it("rejects when Linear reports success false or GraphQL errors", async () => {
    const no = fakeFetch(() => ok({ commentCreate: { success: false } }));
    await expect(
      new LinearApi({ apiKey: "k", fetchImpl: no as unknown as typeof fetch }).createComment({ issueId: "i" }, "x"),
    ).rejects.toMatchObject({ code: "bad_response" });
    const err = fakeFetch(() => new Response(JSON.stringify({ errors: [{ message: "Entity not found" }] }), { status: 200 }));
    await expect(
      new LinearApi({ apiKey: "k", fetchImpl: err as unknown as typeof fetch }).createComment({ issueId: "i" }, "x"),
    ).rejects.toMatchObject({ code: "graphql" });
  });
});

describe("LinearApi.viewer", () => {
  it("returns the key's user", async () => {
    const f = fakeFetch((b) => {
      expect(b.query).toContain("viewer { id name }");
      return ok({ viewer: { id: "u-bot", name: "Atomic Agent" } });
    });
    expect(await new LinearApi({ apiKey: "k", fetchImpl: f as unknown as typeof fetch }).viewer()).toEqual({
      id: "u-bot",
      name: "Atomic Agent",
    });
  });

  it("marks a refused key as auth, without echoing the key", async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
          { status: 400 },
        ),
    );
    const promise = new LinearApi({ apiKey: "lin_api_secretvalue", fetchImpl: f as unknown as typeof fetch }).viewer();
    await expect(promise).rejects.toMatchObject({ code: "auth" });
    await promise.catch((e: Error) => expect(e.message).not.toContain("lin_api_secretvalue"));
  });
});

describe("helpers", () => {
  it("sends a personal key bare and an OAuth token as Bearer", () => {
    expect(linearAuthHeader("lin_api_x")).toBe("lin_api_x");
    expect(linearAuthHeader("oauth-token")).toBe("Bearer oauth-token");
  });

  it("cuts an over-long reply with a note and keeps a short one", () => {
    expect(fitCommentBody("short", 100)).toBe("short");
    const cut = fitCommentBody("x".repeat(500), 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut).toContain("Reply cut");
  });
});

describe("LinearApi.createAgentActivity (ATO-2464)", () => {
  it("sends agentActivityCreate with the session id and typed content, as Bearer for an app token", async () => {
    const f = fakeFetch(() => ok({ agentActivityCreate: { success: true, agentActivity: { id: "a1" } } }));
    const api = new LinearApi({ apiKey: "oauth-app-token", fetchImpl: f as unknown as typeof fetch });
    expect(await api.createAgentActivity("as-1", "thought", "Working on it.")).toBe("a1");
    const init = f.mock.calls[0]![1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer oauth-app-token");
    const sent = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    expect(sent.query).toContain("agentActivityCreate(input: $input)");
    expect(sent.variables).toEqual({ input: { agentSessionId: "as-1", content: { type: "thought", body: "Working on it." } } });
  });

  it("rejects when Linear did not record it", async () => {
    const f = fakeFetch(() => ok({ agentActivityCreate: { success: false } }));
    await expect(
      new LinearApi({ apiKey: "t", fetchImpl: f as unknown as typeof fetch }).createAgentActivity("as-1", "response", "x"),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});
