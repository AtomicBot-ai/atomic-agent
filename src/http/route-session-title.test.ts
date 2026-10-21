import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("PATCH /api/sessions/{id}", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const rename = (h: Harness, id: string, body: unknown, headers = {}) =>
    fetch(`${h.baseUrl}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("renames a session and lists it under the new title", async () => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession({
      metadata: { title: "Generated name" },
    });
    const response = await rename(harness, session.id, {
      title: "  My own name  ",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: session.id,
      title: "My own name",
    });
    const list = (await (
      await fetch(`${harness.baseUrl}/api/sessions`)
    ).json()) as { sessions: Array<{ id: string; title: string | null }> };
    expect(list.sessions.find((s) => s.id === session.id)?.title).toBe(
      "My own name",
    );
    const stored = harness.runtime.sessionStore.load(session.id);
    expect(typeof stored?.metadata?.titleSetByUserAt).toBe("number");
  });

  it("answers 404 for a session that is not stored", async () => {
    harness = await startTestHarness();
    const response = await rename(harness, "missing", { title: "Name" });
    expect(response.status).toBe(404);
  });

  it.each([
    ["a missing title", {}],
    ["a non-string title", { title: 7 }],
    ["a blank title", { title: "   " }],
    ["a multi-line title", { title: "one\ntwo" }],
    ["a title over 120 characters", { title: "x".repeat(121) }],
    ["a body that is not an object", [1, 2]],
    ["a body that is not JSON", "{nope"],
  ])("refuses %s with 400 and leaves the title alone", async (_label, body) => {
    harness = await startTestHarness();
    const session = harness.runtime.createSession({
      metadata: { title: "Kept" },
    });
    const response = await rename(harness, session.id, body);
    expect(response.status).toBe(400);
    expect(
      harness.runtime.sessionStore.load(session.id)?.metadata?.title,
    ).toBe("Kept");
  });

  it("requires the bearer token when one is configured", async () => {
    harness = await startTestHarness({ apiKey: "secret" });
    const session = harness.runtime.createSession();
    const denied = await rename(harness, session.id, { title: "Name" });
    expect(denied.status).toBe(401);
    const allowed = await rename(
      harness,
      session.id,
      { title: "Name" },
      { authorization: "Bearer secret" },
    );
    expect(allowed.status).toBe(200);
  });
});
