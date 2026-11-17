import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import {
  createIncognitoSessions,
  removeIncognitoTrace,
  sweepOrphanIncognitoSessions,
} from "./incognito-sessions.js";

/** ATO-586: closing an incognito chat deletes its row and trace file. */

function probe(pid: number, alive: Set<number>): TurnOwnerProbe {
  return { pid, host: "darwin", hostUptime: () => 50_000, isAlive: (p) => alive.has(p), processStartOf: () => null };
}

describe("incognito sessions in the runtime", () => {
  let dir: string;
  let tracesDir: string;
  let records: LogRecord[];
  let logger: StructuredLogger;
  const stores: SessionStore[] = [];
  const alive = new Set<number>();

  const open = (pid: number): SessionStore => {
    const store = new SessionStore({ dbFile: join(dir, "sessions.sqlite"), turnOwnerProbe: probe(pid, alive) });
    stores.push(store);
    return store;
  };
  const trace = (id: string): string => join(tracesDir, `${id}.ndjson`);
  const save = (store: SessionStore, id: string, incognito: boolean): void => {
    store.save(recordTurn(
      createEmptySessionState({ id, workingDir: "/w", ...(incognito ? { incognito: store.newIncognitoMark() } : {}) }),
      userTurn("hi"),
    ));
    writeFileSync(trace(id), "{}\n");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runtime-incognito-"));
    tracesDir = join(dir, "traces");
    mkdirSync(tracesDir);
    records = [];
    logger = new StructuredLogger({ level: "debug", sinks: [(record) => records.push(record)] });
    alive.clear();
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discard deletes an idle incognito chat and its trace now", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    expect(sessions.discard("s-secret")).toBe("deleted");
    expect(store.load("s-secret")).toBeNull();
    expect(existsSync(trace("s-secret"))).toBe(false);
  });

  it("discard never deletes an ordinary chat", () => {
    const store = open(1);
    save(store, "s-plain", false);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    expect(sessions.discard("s-plain")).toBe("not_incognito");
    expect(sessions.discard("s-never-saved")).toBe("not_incognito");
    expect(store.load("s-plain")).not.toBeNull();
    expect(existsSync(trace("s-plain"))).toBe(true);
  });

  it("waits for a running turn, then deletes once the session is idle", () => {
    const store = open(1);
    save(store, "s-secret", true);
    let busy = true;
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => busy, logger });
    expect(sessions.discard("s-secret")).toBe("deferred");
    expect(store.load("s-secret")).not.toBeNull();
    // Still busy (a turn queued behind): kept.
    sessions.settle("s-secret");
    expect(store.load("s-secret")).not.toBeNull();
    busy = false;
    sessions.settle("s-secret");
    expect(store.load("s-secret")).toBeNull();
    expect(existsSync(trace("s-secret"))).toBe(false);
  });

  it("settle leaves sessions nobody discarded alone", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    sessions.settle("s-secret");
    expect(store.load("s-secret")).not.toBeNull();
  });

  it("the boot sweep deletes a dead process's chats with their traces and logs once", () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    save(open(20), "s-live", true);
    alive.delete(10);
    const boot = open(30);
    expect(sweepOrphanIncognitoSessions(boot, tracesDir, logger)).toEqual(["s-dead"]);
    expect(existsSync(trace("s-dead"))).toBe(false);
    expect(existsSync(trace("s-live"))).toBe(true);
    expect(records.filter((r) => r.message === "deleted incognito chats left by a stopped agent")).toHaveLength(1);
  });

  it("a failing sweep is logged and never throws", () => {
    const failing = { sweepOrphanIncognito: (): string[] => { throw new Error("locked"); } };
    expect(sweepOrphanIncognitoSessions(failing, tracesDir, logger)).toEqual([]);
    expect(records.some((r) => r.level === "warn" && r.context?.error === "locked")).toBe(true);
  });

  it("never removes a file outside the traces folder", () => {
    const outside = join(dir, "keep.ndjson");
    writeFileSync(outside, "{}\n");
    expect(removeIncognitoTrace(tracesDir, "../keep")).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(removeIncognitoTrace(null, "s-any")).toBe(false);
  });
});
