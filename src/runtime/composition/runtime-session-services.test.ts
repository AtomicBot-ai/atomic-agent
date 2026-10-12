import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import * as sessions from "../../session/index.js";
import { SessionStore } from "../../session/session-store.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import { createRuntimeSessionFactories, installRuntimeSessionDelete, prepareRuntimeSessionStore } from "./runtime-session-services.js";

describe("runtime session phases", () => {
  let dir: string;
  let config: AtomicAgentConfig;
  let logger: StructuredLogger;
  let records: LogRecord[];
  const stores: SessionStore[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-runtime-sessions-"));
    config = configuration.loadConfig();
    config.paths.stateDir = dir;
    config.paths.sessionsDbFile = join(dir, "sessions.sqlite");
    config.paths.tasksDbFile = join(dir, "tasks.sqlite");
    config.paths.tracesDir = join(dir, "traces");
    config.sessions.retention.enabled = false;
    records = [];
    logger = new StructuredLogger({ level: "debug", sinks: [record => records.push(record)] });
    vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  function open() { const store = prepareRuntimeSessionStore(config, logger); stores.push(store); return store; }

  it("recovers before retention reads pins and passes the existing pin sources", () => {
    config.sessions.retention.enabled = true;
    const events: string[] = [];
    vi.spyOn(SessionStore.prototype, "recoverInterruptedTurns").mockImplementation(() => { events.push("recover"); return ["old"]; });
    const pins = vi.spyOn(sessions, "readSessionPins").mockImplementation(() => { events.push("pins"); return ["keep"]; });
    vi.spyOn(sessions, "pruneSessions").mockImplementation(options => {
      events.push("prune"); expect(options.keepSessionIds).toEqual(["keep"]);
      return { deleted: 0, orphans: 0, unreadable: 0, tracesRemoved: 0, vacuumed: false };
    });
    open();
    expect(events).toEqual(["recover", "pins", "prune"]);
    expect(pins).toHaveBeenCalledWith({ tasksDbFile: config.paths.tasksDbFile, webhookSessionsFile: join(dir, "webhook-sessions.json") });
    expect(records.map(record => record.message)).toContain("sessions left mid-turn by a stopped agent marked cancelled");
    expect(records.some(record => record.message === "pruned sessions past retention")).toBe(false);
  });

  it("recovery and retention failures are separately logged and preserve the opened store", () => {
    config.sessions.retention.enabled = true;
    vi.spyOn(SessionStore.prototype, "recoverInterruptedTurns").mockImplementation(() => { throw new Error("recovery failed"); });
    vi.spyOn(sessions, "readSessionPins").mockImplementation(() => { throw new Error("pins failed"); });
    const store = open();
    expect(records.filter(record => record.level === "warn").map(record => record.context?.error)).toEqual(["recovery failed", "pins failed"]);
    const state = sessions.createEmptySessionState({ id: "survived", workingDir: dir });
    store.save(state);
    expect(store.load(state.id)?.id).toBe(state.id);
  });

  it("disabled retention does not read external pins or perform a prune", () => {
    const pins = vi.spyOn(sessions, "readSessionPins");
    const prune = vi.spyOn(sessions, "pruneSessions");
    open();
    expect(pins).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it("delete wrapper preserves trace then shell then bound original-store order", () => {
    const events: string[] = [];
    const store = { marker: "store", delete(id: string) { events.push(`${this.marker}:${id}`); } };
    installRuntimeSessionDelete(store, id => events.push(`trace:${id}`), { endSession: id => { events.push(`shell:${id}`); return []; } });
    store.delete("one");
    expect(events).toEqual(["trace:one", "shell:one", "store:one"]);
  });

  it("delete wrapper retains failure precedence before the original deletion", () => {
    const events: string[] = [];
    const failure = new Error("trace failed");
    const store = { delete: (id: string) => { events.push(id); } };
    installRuntimeSessionDelete(store, () => { throw failure; }, { endSession: () => { events.push("shell"); return []; } });
    expect(() => store.delete("one")).toThrow(failure);
    expect(events).toEqual([]);
  });

  it("deferred and ephemeral factories allocate state without saving or opening traces", () => {
    const calls: string[] = [];
    const factories = createRuntimeSessionFactories(dir, { save: state => { calls.push(`save:${state.id}`); } }, state => { calls.push(`trace:${state.id}`); return null; });
    const metadata = { custom: 1 };
    const deferred = factories.createSession({ persist: false, metadata });
    const worker = factories.createEphemeralSession({ parentSessionId: deferred.id, taskId: "task" });
    expect(deferred.metadata).toBe(metadata);
    expect(deferred.workingDir).toBe(dir);
    expect(sessions.readFusionWorkerMeta(worker.metadata)).toEqual({ parentSessionId: deferred.id, taskId: "task" });
    expect(worker.id).not.toBe(deferred.id);
    const inherited = factories.createEphemeralSession({ parentSessionId: deferred.id, taskId: "inherited" }, join(dir, "other"));
    expect(inherited.workingDir).toBe(join(dir, "other"));
    expect(inherited.inheritedWorkspace).toBe(true);
    expect(worker.inheritedWorkspace).toBeUndefined();
    expect(calls).toEqual([]);
    const persistent = factories.createSession();
    expect(calls).toEqual([`save:${persistent.id}`, `trace:${persistent.id}`]);
  });

  it("save failure stops recorder creation and propagates the original error", () => {
    const failure = new Error("save failed");
    const recorder = vi.fn(() => null);
    const factories = createRuntimeSessionFactories(dir, { save: () => { throw failure; } }, recorder);
    expect(() => factories.createSession()).toThrow(failure);
    expect(recorder).not.toHaveBeenCalled();
  });
});
