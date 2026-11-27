import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../session/session-store.js";
import { createEmptySessionState } from "../../session/session-state.js";
import {
  formatTrashList,
  parseSessionsArgs,
  resolveTrashTarget,
  runSessionsTrash,
  trashedAgo,
} from "./session-trash-command.js";

const DAY = 24 * 60 * 60 * 1000;

describe("parseSessionsArgs (ATO-2474)", () => {
  it("opens the picker with no arguments", () => {
    expect(parseSessionsArgs("")).toEqual({ picker: true });
    expect(parseSessionsArgs("   ")).toEqual({ picker: true });
  });
  it("reads --deleted and --trash as the Trash list", () => {
    expect(parseSessionsArgs("--deleted")).toEqual({ trash: { verb: "list" } });
    expect(parseSessionsArgs(" --TRASH ")).toEqual({ trash: { verb: "list" } });
  });
  it("reads --restore with exactly one target", () => {
    expect(parseSessionsArgs("--restore 2")).toEqual({ trash: { verb: "restore", target: "2" } });
    expect(parseSessionsArgs("--restore")).toHaveProperty("usage");
    expect(parseSessionsArgs("--restore 1 2")).toHaveProperty("usage");
  });
  it("answers anything else with the usage line", () => {
    expect(parseSessionsArgs("--archived")).toHaveProperty("usage");
    expect(parseSessionsArgs("--deleted now")).toHaveProperty("usage");
  });
});

describe("Trash list text", () => {
  it("says when Trash is empty", () => {
    expect(formatTrashList([], 0)).toBe("Trash is empty.");
  });
  it("numbers the chats and says how to restore one", () => {
    const text = formatTrashList([
      { id: "abcdef123456", workingDir: "/w", updatedAt: 1, title: "Trip plan", firstPrompt: "plan", trashedAt: 10 * DAY - 2 * DAY },
      { id: "zz", workingDir: "/w", updatedAt: 1, title: null, firstPrompt: null, trashedAt: null },
    ], 10 * DAY);
    expect(text).toContain("2 chats in Trash");
    expect(text).toContain("1. Trip plan · moved 2 days ago · abcdef12");
    expect(text).toContain("2. chat zz · zz");
    expect(text).toContain("/sessions --restore <number or id>");
  });
  it("words the age", () => {
    expect(trashedAgo(100, 100)).toBe("today");
    expect(trashedAgo(0, DAY + 5)).toBe("yesterday");
    expect(trashedAgo(null, 5)).toBe("");
  });
  it("resolves a number, an id and a unique start of one", () => {
    const rows = [
      { id: "aa11", workingDir: "/w", updatedAt: 1, title: "A", firstPrompt: null, trashedAt: 1 },
      { id: "aa22", workingDir: "/w", updatedAt: 1, title: "B", firstPrompt: null, trashedAt: 1 },
      { id: "bb33", workingDir: "/w", updatedAt: 1, title: "C", firstPrompt: null, trashedAt: 1 },
    ];
    expect(resolveTrashTarget(rows, "2")).toMatchObject({ id: "aa22" });
    expect(resolveTrashTarget(rows, "aa11")).toMatchObject({ id: "aa11" });
    expect(resolveTrashTarget(rows, "bb")).toMatchObject({ id: "bb33" });
    expect(resolveTrashTarget(rows, "aa")).toHaveProperty("error");
    expect(resolveTrashTarget(rows, "4")).toHaveProperty("error");
    expect(resolveTrashTarget(rows, "zz")).toHaveProperty("error");
  });
});

describe("runSessionsTrash against the store", () => {
  let tmp: string;
  let store: SessionStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-tui-trash-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite") });
    for (const id of ["s1", "s2"]) {
      store.save({
        ...createEmptySessionState({ id, workingDir: "/w" }),
        metadata: { title: `Chat ${id}` },
        turns: [{ kind: "user", text: `hello ${id}`, at: 1 }],
      });
    }
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists only the chats in Trash", () => {
    store.setSessionTrashed("s1", true, 1_000);
    const out = runSessionsTrash(store, { verb: "list" }, 1_000);
    expect(out.text).toContain("1 chat in Trash");
    expect(out.text).toContain("Chat s1");
    expect(out.text).not.toContain("Chat s2");
    expect(out.restoredId).toBeUndefined();
  });

  it("restores by number: the chat is back on the summary page and out of Trash", () => {
    store.setSessionTrashed("s1", true, 1_000);
    expect(store.listSummaryPage({ limit: 10 }).map((r) => r.id)).toEqual(["s2"]);
    const out = runSessionsTrash(store, { verb: "restore", target: "1" }, 2_000);
    expect(out.restoredId).toBe("s1");
    expect(out.text).toContain("Restored Chat s1");
    expect(store.load("s1")?.metadata?.trashed).toBeUndefined();
    expect(store.listSummaryPage({ limit: 10 }).map((r) => r.id).sort()).toEqual(["s1", "s2"]);
    expect(store.listTrashed()).toEqual([]);
  });

  it("will not restore a chat that is not in Trash", () => {
    const out = runSessionsTrash(store, { verb: "restore", target: "s2" });
    expect(out.restoredId).toBeUndefined();
    expect(out.text).toContain("No chat in Trash matches s2");
  });
});
