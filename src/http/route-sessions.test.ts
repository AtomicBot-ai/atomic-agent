import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("/api/sessions", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("lists sessions scoped to the runtime working directory", async () => {
    const a = harness.runtime.createSession({ metadata: { kind: "a" } });
    const b = harness.runtime.createSession({ metadata: { kind: "b" } });
    const response = await fetch(`${harness.baseUrl}/api/sessions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>;
    };
    const ids = body.sessions.map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("returns the full session state for a known id", async () => {
    const session = harness.runtime.createSession();
    const response = await fetch(
      `${harness.baseUrl}/api/sessions/${session.id}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      turns: unknown[];
      metadata: Record<string, unknown>;
    };
    expect(body.id).toBe(session.id);
    expect(Array.isArray(body.turns)).toBe(true);
  });

  it("returns 404 for an unknown session id", async () => {
    const response = await fetch(`${harness.baseUrl}/api/sessions/missing`);
    expect(response.status).toBe(404);
  });

  it("deletes a session idempotently", async () => {
    const session = harness.runtime.createSession();
    const first = await fetch(`${harness.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(first.status).toBe(200);
    expect(harness.runtime.sessionStore.load(session.id)).toBeNull();
    const second = await fetch(`${harness.baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(second.status).toBe(200);
  });
});
