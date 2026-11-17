import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn } from "./session-state.js";
import { userTurn } from "./conversation-turn.js";
import { isIncognitoSession } from "./incognito.js";
import { parseTurnOwner, type TurnOwnerProbe } from "./turn-owner.js";

/**
 * ATO-586. An incognito chat is stored while it is open (every runtime
 * path loads sessions by id) but never listed, and the boot sweep deletes
 * one whose process is gone.
 */

const ALIVE = new Set<number>();

function probe(pid: number): TurnOwnerProbe {
  return {
    pid,
    host: "darwin",
    hostUptime: () => 50_000,
    isAlive: (p) => ALIVE.has(p),
    processStartOf: () => null,
  };
}

describe("incognito sessions in the store", () => {
  let dir: string;
  let file: string;
  const stores: SessionStore[] = [];

  const open = (pid: number): SessionStore => {
    const store = new SessionStore({ dbFile: file, turnOwnerProbe: probe(pid) });
    stores.push(store);
    return store;
  };

  const spoken = (id: string, store: SessionStore, incognito: boolean) =>
    recordTurn(
      createEmptySessionState({
        id,
        workingDir: "/work",
        ...(incognito ? { incognito: store.newIncognitoMark() } : {}),
      }),
      userTurn(`hello from ${id}`),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-incognito-"));
    file = join(dir, "sessions.sqlite");
    ALIVE.clear();
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a new chat with this process as its owner", () => {
    const store = open(4242);
    const mark = store.newIncognitoMark(1234);
    expect(mark.since).toBe(1234);
    expect(parseTurnOwner(mark.owner)?.pid).toBe(4242);
    expect(isIncognitoSession({ incognito: mark })).toBe(true);
    expect(isIncognitoSession(createEmptySessionState({ id: "x", workingDir: "/w" }))).toBe(false);
    expect(isIncognitoSession(null)).toBe(false);
  });

  it("loads an incognito chat by id but leaves it out of every list", () => {
    const store = open(1);
    store.save(spoken("s-plain", store, false));
    store.save(spoken("s-secret", store, true));

    expect(store.load("s-secret")?.incognito).toBeDefined();
    expect(store.isIncognito("s-secret")).toBe(true);
    expect(store.isIncognito("s-plain")).toBe(false);
    expect(store.isIncognito("s-missing")).toBe(false);

    expect(store.listRecent(10).map((s) => s.id)).toEqual(["s-plain"]);
    expect(store.listByWorkingDir("/work", 10).map((s) => s.id)).toEqual(["s-plain"]);
    expect(store.listSummaryPage({ limit: 10 }).map((s) => s.id)).toEqual(["s-plain"]);
  });

  it("keeps the mark through a save of a later copy", () => {
    const store = open(1);
    const state = spoken("s-secret", store, true);
    store.save(state);
    store.save(recordTurn(store.load("s-secret")!, userTurn("again")));
    expect(store.load("s-secret")?.incognito).toEqual(state.incognito);
    expect(store.listRecent(10)).toEqual([]);
  });

  it("the boot sweep deletes chats whose process is gone and keeps live ones", () => {
    ALIVE.add(10).add(20);
    const dead = open(10);
    dead.save(spoken("s-dead", dead, true));
    const live = open(20);
    live.save(spoken("s-live", live, true));
    live.save(spoken("s-plain", live, false));
    ALIVE.delete(10);

    const boot = open(30);
    expect(boot.sweepOrphanIncognito()).toEqual(["s-dead"]);
    expect(boot.load("s-dead")).toBeNull();
    expect(boot.load("s-live")).not.toBeNull();
    expect(boot.load("s-plain")).not.toBeNull();
    // A second sweep has nothing left to do.
    expect(boot.sweepOrphanIncognito()).toEqual([]);
  });

  it("the boot sweep treats an unreadable owner as gone", () => {
    const store = open(1);
    const state = { ...spoken("s-broken", store, true), incognito: { since: 1, owner: "not json" } };
    store.save(state);
    expect(open(2).sweepOrphanIncognito()).toEqual(["s-broken"]);
  });
});
