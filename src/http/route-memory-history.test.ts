import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("/api/memory history and undo (ATO-1059)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const send = (path: string, method: string, body?: unknown): Promise<Response> =>
    fetch(`${harness.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });

  it("lists a deletion made through the route as the person's, and undoes it", async () => {
    const note = harness.runtime.notesStore.store({ content: "wrong note" });
    expect((await send(`/api/memory/notes/${note.id}`, "DELETE")).status).toBe(200);

    const listed = (await (await fetch(`${harness.baseUrl}/api/memory/changes`)).json()) as {
      changes: Array<{ id: number; kind: string; op: string; by: string; target: string }>;
    };
    expect(listed.changes).toHaveLength(1);
    expect(listed.changes[0]).toMatchObject({ kind: "note", op: "remove", by: "user", target: String(note.id) });

    const restored = await send(`/api/memory/changes/${listed.changes[0]!.id}/restore`, "POST");
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { restored: boolean; note: { id: number; content: string } };
    expect(body).toMatchObject({ restored: true, note: { id: note.id, content: "wrong note" } });

    const again = await send(`/api/memory/changes/${listed.changes[0]!.id}/restore`, "POST");
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("already_restored");
  });

  it("filters by kind and validates the query", async () => {
    const profile = harness.runtime.profileStore;
    profile.set("city", "Porto");
    profile.remove("city");
    const note = harness.runtime.notesStore.store({ content: "n" });
    harness.runtime.notesStore.remove(note.id);
    const onlyProfile = (await (await fetch(`${harness.baseUrl}/api/memory/changes?kind=profile`)).json()) as {
      changes: Array<{ kind: string; by: string }>;
    };
    expect(onlyProfile.changes).toEqual([expect.objectContaining({ kind: "profile", by: "agent" })]);
    expect((await fetch(`${harness.baseUrl}/api/memory/changes?kind=lesson`)).status).toBe(400);
    expect((await fetch(`${harness.baseUrl}/api/memory/changes?limit=0`)).status).toBe(400);
    expect((await send("/api/memory/changes/abc/restore", "POST")).status).toBe(400);
    expect((await send("/api/memory/changes/99999/restore", "POST")).status).toBe(404);
  });

  it("puts an earlier profile version back", async () => {
    const profile = harness.runtime.profileStore;
    const first = profile.set("city", "Lisbon");
    profile.set("city", "Porto");
    const response = await send("/api/memory/profile/city/restore", "POST", { versionId: first.id });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { fact: { value: string } }).fact.value).toBe("Lisbon");
    expect((await send("/api/memory/profile/city/restore", "POST", { versionId: 99999 })).status).toBe(404);
    expect((await send("/api/memory/profile/city/restore", "POST", { versionId: "x" })).status).toBe(400);
  });
});
