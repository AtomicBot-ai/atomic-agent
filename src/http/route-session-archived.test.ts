import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

// ATO-1150: archive a chat through the agent, so every client sees it.
describe("POST /api/sessions/{id}/archived", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const setArchived = (h: Harness, id: string, body: unknown, headers = {}) =>
    fetch(`${h.baseUrl}/api/sessions/${id}/archived`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const listed = async (h: Harness, id: string) => {
    const list = (await (await fetch(`${h.baseUrl}/api/sessions`)).json()) as {
      sessions: Array<{ id: string; archived: boolean }>;
    };
    return list.sessions.find((s) => s.id === id);
  };

  it("archives: metadata has archived:true and GET /api/sessions lists it", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    expect((await listed(harness, session.id))?.archived).toBe(false);

    const response = await setArchived(harness, session.id, { archived: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: session.id, archived: true });
    const stored = harness.runtime.sessionStore.load(session.id);
    expect(stored?.metadata?.archived).toBe(true);
    expect(typeof stored?.metadata?.archivedSetAt).toBe("number");
    expect((await listed(harness, session.id))?.archived).toBe(true);
  });

  it("unarchives: the key goes and the list says false", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    await setArchived(harness, session.id, { archived: true });
    const response = await setArchived(harness, session.id, { archived: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: session.id, archived: false });
    expect(harness.runtime.sessionStore.load(session.id)?.metadata?.archived).toBeUndefined();
    expect((await listed(harness, session.id))?.archived).toBe(false);
  });

  it("answers 404 for a session that is not stored", async () => {
    harness = await startTestHarness();
    expect((await setArchived(harness, "missing", { archived: true })).status).toBe(404);
  });

  it.each([
    ["a missing flag", {}],
    ["a string flag", { archived: "true" }],
    ["a body that is not an object", [true]],
    ["a body that is not JSON", "{nope"],
  ])("refuses %s with 400 and leaves the chat as it was", async (_label, body) => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    expect((await setArchived(harness, session.id, body)).status).toBe(400);
    expect(harness.runtime.sessionStore.load(session.id)?.metadata?.archived).toBeUndefined();
  });

  it("requires the bearer token when one is configured", async () => {
    harness = await startTestHarness({ apiKey: "secret" });
    const session = harness.runtime.createSession();
    expect((await setArchived(harness, session.id, { archived: true })).status).toBe(401);
    const allowed = await setArchived(harness, session.id, { archived: true }, { authorization: "Bearer secret" });
    expect(allowed.status).toBe(200);
  });
});
