import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface NoteBody {
  id: number;
  content: string;
  source: string;
}

interface FactBody {
  id: number;
  key: string;
  value: string;
  pinned: boolean;
  keywords: string[];
  supersededBy: number | null;
}

describe("/api/memory notes and profile (ATO-1124)", () => {
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

  it("lists notes newest first", async () => {
    const notes = harness.runtime.notesStore;
    const older = notes.store({ content: "first note" }, 1_000);
    const newer = notes.store({ content: "second note" }, 2_000);
    const response = await fetch(`${harness.baseUrl}/api/memory/notes?limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { notes: NoteBody[] };
    expect(body.notes.map((n) => n.id)).toEqual([newer.id, older.id]);
  });

  it("rejects a limit outside 1..200", async () => {
    expect((await fetch(`${harness.baseUrl}/api/memory/notes?limit=0`)).status).toBe(400);
    expect((await fetch(`${harness.baseUrl}/api/memory/notes?limit=abc`)).status).toBe(400);
  });

  it("edits a note's text", async () => {
    const note = harness.runtime.notesStore.store({ content: "likes tea" });
    const response = await send(`/api/memory/notes/${note.id}`, "PATCH", { text: "likes coffee" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { note: NoteBody };
    expect(body.note).toMatchObject({ id: note.id, content: "likes coffee", source: "agent" });
    expect(harness.runtime.notesStore.get(note.id)?.content).toBe("likes coffee");
  });

  it("answers 400 for a bad id or body and 404 for an unknown note", async () => {
    const note = harness.runtime.notesStore.store({ content: "x" });
    expect((await send("/api/memory/notes/abc", "PATCH", { text: "y" })).status).toBe(400);
    expect((await send(`/api/memory/notes/${note.id}`, "PATCH", { text: 5 })).status).toBe(400);
    expect((await send(`/api/memory/notes/${note.id}`, "PATCH", { text: "  " })).status).toBe(400);
    expect((await send("/api/memory/notes/99999", "PATCH", { text: "y" })).status).toBe(404);
    expect((await send("/api/memory/notes/99999", "DELETE")).status).toBe(404);
  });

  it("deletes a note", async () => {
    const note = harness.runtime.notesStore.store({ content: "forget me" });
    const response = await send(`/api/memory/notes/${note.id}`, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, id: note.id });
    expect(harness.runtime.notesStore.get(note.id)).toBeNull();
  });

  it("lists, edits (keeping pinned and keywords) and deletes a profile fact", async () => {
    const profile = harness.runtime.profileStore;
    profile.set("diet", "vegetarian", { pinned: false, keywords: ["food"] });
    const listed = (await (await fetch(`${harness.baseUrl}/api/memory/profile`)).json()) as {
      facts: FactBody[];
    };
    expect(listed.facts.map((f) => [f.key, f.value])).toEqual([["diet", "vegetarian"]]);

    const edited = await send("/api/memory/profile/diet", "PATCH", { value: "vegan" });
    expect(edited.status).toBe(200);
    const { fact } = (await edited.json()) as { fact: FactBody };
    expect(fact).toMatchObject({ key: "diet", value: "vegan", pinned: false, keywords: ["food"] });

    const history = (await (await fetch(`${harness.baseUrl}/api/memory/profile/diet/history`)).json()) as {
      key: string;
      versions: FactBody[];
    };
    expect(history.versions.map((v) => v.value)).toEqual(["vegetarian", "vegan"]);
    expect(history.versions.at(-1)?.supersededBy).toBeNull();

    const removed = await send("/api/memory/profile/diet", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, key: "diet" });
    expect(profile.get("diet")).toBeNull();
  });

  it("answers 404 for an unknown profile key and 400 for a non-string value", async () => {
    harness.runtime.profileStore.set("city", "Porto");
    expect((await send("/api/memory/profile/nope", "PATCH", { value: "x" })).status).toBe(404);
    expect((await send("/api/memory/profile/nope", "DELETE")).status).toBe(404);
    expect((await send("/api/memory/profile/city", "PATCH", { value: 1 })).status).toBe(400);
  });
  it("turns one note off and on with PATCH, and lists it marked (ATO-1124)", async () => {
    const notes = harness.runtime.notesStore;
    const note = notes.store({ content: "the user is allergic to peanuts" });

    const off = await send(`/api/memory/notes/${note.id}`, "PATCH", { disabled: true });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { note: NoteBody & { disabled: boolean; disabledAt: number | null } };
    expect(offBody.note).toMatchObject({ id: note.id, content: "the user is allergic to peanuts", disabled: true });
    expect(typeof offBody.note.disabledAt).toBe("number");
    expect(notes.recall("peanuts")).toEqual([]);

    const listed = (await (await fetch(`${harness.baseUrl}/api/memory/notes`)).json()) as {
      notes: Array<{ id: number; disabled: boolean }>;
    };
    expect(listed.notes).toEqual([expect.objectContaining({ id: note.id, disabled: true })]);

    const on = await send(`/api/memory/notes/${note.id}`, "PATCH", { disabled: false });
    expect(((await on.json()) as { note: { disabled: boolean; disabledAt: number | null } }).note).toMatchObject({
      disabled: false,
      disabledAt: null,
    });
    expect(notes.recall("peanuts").map((e) => e.id)).toEqual([note.id]);

    expect((await send(`/api/memory/notes/${note.id}`, "PATCH", { disabled: "yes" })).status).toBe(400);
    expect((await send(`/api/memory/notes/${note.id}`, "PATCH", {})).status).toBe(400);
    expect((await send("/api/memory/notes/999999", "PATCH", { disabled: true })).status).toBe(404);
  });

  it("turns one profile fact off with PATCH: listed, not in the prompt (ATO-1124)", async () => {
    const profile = harness.runtime.profileStore;
    profile.set("diet", "vegetarian");

    const off = await send("/api/memory/profile/diet", "PATCH", { disabled: true });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { fact: FactBody & { disabled: boolean } }).fact).toMatchObject({
      key: "diet",
      value: "vegetarian",
      disabled: true,
    });
    expect(profile.listForPrompt().map((f) => f.key)).not.toContain("diet");

    const listed = (await (await fetch(`${harness.baseUrl}/api/memory/profile`)).json()) as {
      facts: Array<{ key: string; disabled: boolean }>;
    };
    expect(listed.facts).toEqual([expect.objectContaining({ key: "diet", disabled: true })]);

    // Editing the value keeps it off; a value and the switch can go together.
    const edited = await send("/api/memory/profile/diet", "PATCH", { value: "vegan", disabled: false });
    expect(((await edited.json()) as { fact: { value: string; disabled: boolean } }).fact).toMatchObject({
      value: "vegan",
      disabled: false,
    });
    expect(profile.listForPrompt().map((f) => f.key)).toContain("diet");

    expect((await send("/api/memory/profile/diet", "PATCH", { disabled: 1 })).status).toBe(400);
    expect((await send("/api/memory/profile/nope", "PATCH", { disabled: true })).status).toBe(404);
  });
});
