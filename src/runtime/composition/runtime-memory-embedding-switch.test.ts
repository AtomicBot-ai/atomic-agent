import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime-memory-stores.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-memory-stores.js")>("./runtime-memory-stores.js");
  return { ...actual, attachConfiguredEmbeddings: vi.fn() };
});

import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { AgentMetrics } from "../../tracing/agent-metrics.js";
import { MetricsCollector } from "../../tracing/metrics-collector.js";
import * as stores from "./runtime-memory-stores.js";
import type { AttachedMemoryEmbeddings, EmbeddingBackfillHandle } from "./runtime-memory-stores.js";
import { createMemoryEmbeddingSwitch } from "./runtime-memory-embedding-switch.js";

const metrics = new AgentMetrics(new MetricsCollector({ sinks: [] }));
const attach = vi.mocked(stores.attachConfiguredEmbeddings);

type Cfg = Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;

function cfg(modelId: string | null, enabled = true): Cfg {
  return {
    paths: {},
    memory: { embeddings: { enabled } },
    localModels: { embeddings: { enabled, modelId } },
  } as unknown as Cfg;
}

function backfill(): EmbeddingBackfillHandle & { stop: ReturnType<typeof vi.fn> } {
  return { done: Promise.resolve(null), stop: vi.fn(async () => {}) };
}

function attached(over: Partial<AttachedMemoryEmbeddings>): AttachedMemoryEmbeddings {
  return { health: "ok", modelId: null, client: null, backfill: null, failure: null, ...over };
}

function notes(order: string[] = []) {
  return {
    attachEmbeddings: vi.fn(),
    detachEmbeddings: vi.fn(() => order.push("detach")),
    getDatabaseHandleForEmbeddings: vi.fn(),
  };
}

afterEach(() => {
  attach.mockReset();
});

describe("memory embedding switch (ATO-351)", () => {
  it("stops the old backfill, detaches, then attaches the newly configured model", async () => {
    const order: string[] = [];
    const oldBackfill = backfill();
    oldBackfill.stop.mockImplementation(async () => { order.push("stop-backfill"); });
    let config = cfg("model-a");
    const sw = createMemoryEmbeddingSwitch({
      notesStore: notes(order), metrics, readConfig: () => config,
      initial: { health: "ok", modelId: "model-a", backfill: oldBackfill },
    });
    config = cfg("model-b");
    attach.mockImplementation(async (args) => {
      order.push("attach");
      expect(args.config).toBe(config);
      return attached({ health: "ok", modelId: "model-b" });
    });

    const result = await sw.reconnect();

    expect(order).toEqual(["stop-backfill", "detach", "attach"]);
    expect(result).toEqual({ health: "ok", modelId: "model-b", changed: true });
  });

  it("leaves a working attachment alone when the config still names the same model", async () => {
    const store = notes();
    const sw = createMemoryEmbeddingSwitch({
      notesStore: store, metrics, readConfig: () => cfg("model-a"),
      initial: { health: "ok", modelId: "model-a", backfill: null },
    });

    expect(await sw.reconnect()).toMatchObject({ health: "ok", modelId: "model-a", changed: false });
    expect(store.detachEmbeddings).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("stays detached, with the reason, when the new model does not answer", async () => {
    const store = notes();
    const sw = createMemoryEmbeddingSwitch({
      notesStore: store, metrics, readConfig: () => cfg("model-b"),
      initial: { health: "ok", modelId: "model-a", backfill: null },
    });
    attach.mockResolvedValue(attached({
      health: "unreachable", modelId: "model-b", failure: { kind: "unreachable", message: "daemon down" },
    }));

    expect(await sw.reconnect()).toEqual({ health: "unreachable", modelId: "model-b", why: "daemon down", changed: true });
    expect(store.detachEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("retries a model that was unreachable at boot", async () => {
    const sw = createMemoryEmbeddingSwitch({
      notesStore: notes(), metrics, readConfig: () => cfg("model-a"),
      initial: { health: "unreachable", modelId: "model-a", backfill: null },
    });
    attach.mockResolvedValue(attached({ health: "ok", modelId: "model-a" }));

    expect(await sw.reconnect()).toMatchObject({ health: "ok", changed: true });
  });

  it("detaches when embeddings are turned off", async () => {
    const store = notes();
    const sw = createMemoryEmbeddingSwitch({
      notesStore: store, metrics, readConfig: () => cfg("model-a", false),
      initial: { health: "ok", modelId: "model-a", backfill: null },
    });
    attach.mockResolvedValue(attached({ health: "disabled", modelId: null }));

    expect(await sw.reconnect()).toMatchObject({ health: "disabled", modelId: null, changed: true });
    expect(store.detachEmbeddings).toHaveBeenCalledTimes(1);
  });

  it("runs reconnects one at a time", async () => {
    let config = cfg("model-a");
    const sw = createMemoryEmbeddingSwitch({
      notesStore: notes(), metrics, readConfig: () => config,
      initial: { health: "ok", modelId: "model-a", backfill: null },
    });
    config = cfg("model-b");
    let release!: () => void;
    attach.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(attached({ health: "ok", modelId: "model-b" }));
    }));
    const first = sw.reconnect();
    const second = sw.reconnect();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toMatchObject({ modelId: "model-b", changed: true });
    // The second saw the first's result and had nothing left to do.
    expect(await second).toMatchObject({ modelId: "model-b", changed: false });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("undoes an attach that lands after shutdown began, and ignores later reconnects", async () => {
    const store = notes();
    const sw = createMemoryEmbeddingSwitch({
      notesStore: store, metrics, readConfig: () => cfg("model-b"),
      initial: { health: "ok", modelId: "model-a", backfill: null },
    });
    const lateBackfill = backfill();
    let release!: () => void;
    attach.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(attached({ health: "ok", modelId: "model-b", backfill: lateBackfill }));
    }));
    const pending = sw.reconnect();
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const stopped = sw.stop();
    release();
    await pending;
    await stopped;

    expect(lateBackfill.stop).toHaveBeenCalledTimes(1);
    expect(store.detachEmbeddings).toHaveBeenCalledTimes(2);
    await sw.reconnect();
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("stop() stops the backfill the boot started", async () => {
    const boot = backfill();
    const sw = createMemoryEmbeddingSwitch({
      notesStore: notes(), metrics, readConfig: () => cfg("model-a"),
      initial: { health: "ok", modelId: "model-a", backfill: boot },
    });
    await sw.stop();
    expect(boot.stop).toHaveBeenCalledTimes(1);
  });
});
