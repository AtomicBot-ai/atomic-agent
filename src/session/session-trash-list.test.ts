import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState } from "./session-state.js";

// ATO-2474: a chat in Trash is off every summary page and on the Trash list.
describe("summary pages and the Trash list", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-trash-list-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function chat(id: string, text: string, title?: string): void {
    store.save({
      ...createEmptySessionState({ id, workingDir: "/w" }),
      ...(title ? { metadata: { title } } : {}),
      turns: [
        { kind: "user", text, at: 1 },
        { kind: "assistant_reply", text: "noted", at: 2 },
      ],
    });
  }
  const listed = () => store.listSummaryPage({ limit: 50 }).map((row) => row.id).sort();

  it("leaves a chat in Trash off the summary page and lists it in Trash", () => {
    chat("s1", "plan the trip", "Trip plan");
    chat("s2", "budget");
    expect(listed()).toEqual(["s1", "s2"]);
    expect(store.listTrashed()).toEqual([]);

    store.setSessionTrashed("s1", true, 5_000);
    expect(listed()).toEqual(["s2"]);
    expect(store.listTrashed()).toEqual([
      expect.objectContaining({ id: "s1", title: "Trip plan", firstPrompt: "plan the trip", trashedAt: 5_000, workingDir: "/w" }),
    ]);
  });

  it("puts a restored chat back on the page and takes it off the Trash list", () => {
    chat("s1", "plan the trip");
    store.setSessionTrashed("s1", true, 5_000);
    store.setSessionTrashed("s1", false, 6_000);
    expect(listed()).toEqual(["s1"]);
    expect(store.listTrashed()).toEqual([]);
  });

  it("lists Trash newest move first and honours the limit", () => {
    chat("a", "one");
    chat("b", "two");
    chat("c", "three");
    store.setSessionTrashed("a", true, 1_000);
    store.setSessionTrashed("b", true, 3_000);
    store.setSessionTrashed("c", true, 2_000);
    expect(store.listTrashed().map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(store.listTrashed(1).map((row) => row.id)).toEqual(["b"]);
  });

  it("does not count a non-boolean trashed value as Trash", () => {
    store.save({
      ...createEmptySessionState({ id: "odd", workingDir: "/w" }),
      metadata: { trashed: "yes" },
      turns: [{ kind: "user", text: "hello", at: 1 }],
    });
    expect(listed()).toEqual(["odd"]);
    expect(store.listTrashed()).toEqual([]);
  });
});
