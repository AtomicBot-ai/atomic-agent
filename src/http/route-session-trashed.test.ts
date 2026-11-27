import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

// ATO-2332: the desktop's Trash, stamped on the session so search leaves it out.
describe("POST /api/sessions/{id}/trashed", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const setTrashed = (h: Harness, id: string, body: unknown, headers = {}) =>
    fetch(`${h.baseUrl}/api/sessions/${id}/trashed`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("moves to Trash: metadata has trashed:true and a stamp", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    const response = await setTrashed(harness, session.id, { trashed: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: session.id, trashed: true });
    const stored = harness.runtime.sessionStore.load(session.id);
    expect(stored?.metadata?.trashed).toBe(true);
    expect(typeof stored?.metadata?.trashedSetAt).toBe("number");
  });

  it("restores: the key goes", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    await setTrashed(harness, session.id, { trashed: true });
    const response = await setTrashed(harness, session.id, { trashed: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: session.id, trashed: false });
    expect(harness.runtime.sessionStore.load(session.id)?.metadata?.trashed).toBeUndefined();
  });

  it("answers 404 for a session that is not stored", async () => {
    harness = await startTestHarness();
    expect((await setTrashed(harness, "missing", { trashed: true })).status).toBe(404);
  });

  it.each([
    ["a missing flag", {}],
    ["a string flag", { trashed: "true" }],
    ["a body that is not an object", [true]],
    ["a body that is not JSON", "{nope"],
  ])("refuses %s with 400 and leaves the chat as it was", async (_label, body) => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession();
    expect((await setTrashed(harness, session.id, body)).status).toBe(400);
    expect(harness.runtime.sessionStore.load(session.id)?.metadata?.trashed).toBeUndefined();
  });

  it("requires the bearer token when one is configured", async () => {
    harness = await startTestHarness({ apiKey: "secret" });
    const session = harness.runtime.createSession();
    expect((await setTrashed(harness, session.id, { trashed: true })).status).toBe(401);
    const allowed = await setTrashed(harness, session.id, { trashed: true }, { authorization: "Bearer secret" });
    expect(allowed.status).toBe(200);
  });
});
