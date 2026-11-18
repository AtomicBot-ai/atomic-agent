import { describe, it, expect } from "vitest";
import {
  FUSION_WORKER_ID_PREFIX,
  FUSION_WORKER_METADATA_KEY,
  childFusionWorkerDepth,
  createFusionWorkerSession,
  isFusionWorkerSessionId,
  readFusionWorkerMeta,
  readSessionDepth,
} from "./fusion-worker-session.js";

describe("fusion worker sessions", () => {
  const meta = { parentSessionId: "s-parent", taskId: "task-1" };

  it("mints an s-w- id, stamps the metadata, and starts empty", () => {
    const session = createFusionWorkerSession({ workingDir: "/work", meta });
    expect(session.id.startsWith(FUSION_WORKER_ID_PREFIX)).toBe(true);
    expect(isFusionWorkerSessionId(session.id)).toBe(true);
    expect(session.workingDir).toBe("/work");
    expect(session.turns).toEqual([]);
    expect(session.metadata[FUSION_WORKER_METADATA_KEY]).toEqual({ ...meta, depth: 1 });
    expect(readFusionWorkerMeta(session.metadata)).toEqual({ ...meta, depth: 1 });
  });

  it("two workers never share an id", () => {
    const a = createFusionWorkerSession({ workingDir: "/work", meta });
    const b = createFusionWorkerSession({ workingDir: "/work", meta });
    expect(a.id).not.toBe(b.id);
  });

  it("a real session id is not a worker id", () => {
    expect(isFusionWorkerSessionId("s-1234")).toBe(false);
    expect(isFusionWorkerSessionId("")).toBe(false);
  });

  it("readFusionWorkerMeta is defensive about malformed metadata", () => {
    expect(readFusionWorkerMeta(undefined)).toBeNull();
    expect(readFusionWorkerMeta({})).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: null }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: "yes" }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: [] }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s" },
      }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "", taskId: "t" },
      }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s", taskId: 3 },
      }),
    ).toBeNull();
    // Extra keys are dropped, not carried.
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { ...meta, extra: true },
      }),
    ).toEqual({ ...meta, depth: 1 });
  });

  describe("depth (ATO-1666)", () => {
    it("stamps the given depth and defaults to 1 when none is given", () => {
      const deep = createFusionWorkerSession({
        workingDir: "/work",
        meta: { ...meta, depth: 3 },
      });
      expect(deep.metadata[FUSION_WORKER_METADATA_KEY]).toEqual({ ...meta, depth: 3 });
      expect(readFusionWorkerMeta(deep.metadata)?.depth).toBe(3);
      expect(readSessionDepth(deep.metadata)).toBe(3);

      const plain = createFusionWorkerSession({ workingDir: "/work", meta });
      expect(
        (plain.metadata[FUSION_WORKER_METADATA_KEY] as { depth?: unknown }).depth,
      ).toBe(1);
    });

    it("a malformed input depth is stamped as 1", () => {
      for (const depth of [0, -2, 1.5, Number.NaN]) {
        const session = createFusionWorkerSession({
          workingDir: "/work",
          meta: { ...meta, depth },
        });
        expect(
          (session.metadata[FUSION_WORKER_METADATA_KEY] as { depth?: unknown }).depth,
        ).toBe(1);
      }
    });

    it("an old record without depth reads as depth 1", () => {
      const old = { [FUSION_WORKER_METADATA_KEY]: { ...meta } };
      expect(readFusionWorkerMeta(old)).toEqual({ ...meta, depth: 1 });
      expect(readSessionDepth(old)).toBe(1);
    });

    it("a malformed depth reads as 1 and the record stays a valid worker", () => {
      for (const depth of [0, -1, 2.5, "2", null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
        const record = { [FUSION_WORKER_METADATA_KEY]: { ...meta, depth } };
        expect(readFusionWorkerMeta(record)).toEqual({ ...meta, depth: 1 });
        expect(readSessionDepth(record)).toBe(1);
      }
    });

    it("a real session has depth 0", () => {
      expect(readSessionDepth(undefined)).toBe(0);
      expect(readSessionDepth({})).toBe(0);
      expect(readSessionDepth({ custom: 1 })).toBe(0);
      // A broken stamp is "not a worker", so depth 0 as well.
      expect(
        readSessionDepth({ [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s" } }),
      ).toBe(0);
    });

    it("a child's depth is its parent's depth + 1", () => {
      expect(childFusionWorkerDepth(undefined)).toBe(1);
      expect(childFusionWorkerDepth({})).toBe(1);

      const worker = createFusionWorkerSession({ workingDir: "/work", meta });
      const childDepth = childFusionWorkerDepth(worker.metadata);
      expect(childDepth).toBe(2);
      const child = createFusionWorkerSession({
        workingDir: "/work",
        meta: { parentSessionId: worker.id, taskId: "task-2", depth: childDepth },
      });
      expect(readSessionDepth(child.metadata)).toBe(2);
      expect(childFusionWorkerDepth(child.metadata)).toBe(3);
    });
  });
});
