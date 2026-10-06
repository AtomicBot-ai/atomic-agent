import { describe, expect, it } from "vitest";

import {
  planSegments,
  streamIntoSegment,
  type Segment,
  type SegmentContext,
} from "./download-segments.js";

const MIN = 8;

describe("planSegments", () => {
  it("splits one hole into equal pieces, one per connection", () => {
    expect(planSegments([[0, 64]], 4, MIN)).toEqual([
      { start: 0, end: 16, written: 0 },
      { start: 16, end: 32, written: 0 },
      { start: 32, end: 48, written: 0 },
      { start: 48, end: 64, written: 0 },
    ]);
  });

  it("never makes a piece smaller than the minimum, so fewer connections are used", () => {
    // 40 bytes across 16 connections would be 3-byte pieces; the floor
    // of 8 yields five.
    const plan = planSegments([[0, 40]], 16, MIN);
    expect(plan).toHaveLength(5);
    expect(plan.every((s) => s.end - s.start === 8)).toBe(true);
  });

  it("keeps a remainder below two minimum pieces as one stream", () => {
    expect(planSegments([[10, 25]], 4, MIN)).toEqual([
      { start: 10, end: 25, written: 0 },
    ]);
  });

  it("keeps one stream when one connection is configured", () => {
    expect(planSegments([[0, 1000]], 1, MIN)).toEqual([
      { start: 0, end: 1000, written: 0 },
    ]);
  });

  it("cannot split an open-ended download", () => {
    expect(planSegments([[0, Infinity]], 8, MIN)).toEqual([
      { start: 0, end: Infinity, written: 0 },
    ]);
  });

  it("chops every hole of a fragmented partial and keeps them in order", () => {
    const plan = planSegments(
      [
        [16, 32],
        [48, 64],
      ],
      4,
      MIN,
    );
    expect(plan).toEqual([
      { start: 16, end: 24, written: 0 },
      { start: 24, end: 32, written: 0 },
      { start: 48, end: 56, written: 0 },
      { start: 56, end: 64, written: 0 },
    ]);
  });

  it("gives an uneven hole a short final piece rather than skipping bytes", () => {
    const plan = planSegments([[0, 50]], 2, MIN);
    expect(plan).toEqual([
      { start: 0, end: 25, written: 0 },
      { start: 25, end: 50, written: 0 },
    ]);
    const odd = planSegments([[0, 51]], 2, MIN);
    expect(odd.at(-1)).toEqual({ start: 26, end: 51, written: 0 });
    expect(odd.reduce((n, s) => n + (s.end - s.start), 0)).toBe(51);
  });
});

describe("streamIntoSegment", () => {
  it("does not count a chunk past a cut that landed while it was being written", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inWrite = new Promise<void>((resolve) => (entered = resolve));
    const writes: Array<[number, number]> = [];
    const handle = {
      write: async (
        buffer: Uint8Array,
        _offset: number,
        length: number,
        position: number,
      ) => {
        writes.push([position, length]);
        entered();
        await gate;
        return { bytesWritten: length, buffer };
      },
    };
    const seg: Segment = { start: 0, end: 32, written: 0 };
    const ctx = {
      handle,
      attemptSignal: new AbortController().signal,
      stallTimeoutMs: 0,
      slowCheckMs: 0,
      onBytes: () => undefined,
    } as unknown as SegmentContext;
    const done = streamIntoSegment(
      new Response(new Uint8Array(32), { status: 206 }),
      seg,
      ctx,
      new AbortController(),
    );
    await inWrite;
    // An idle connection takes 10..32 while the 32-byte chunk is on its
    // way to disk (`download-rebalance.ts`).
    seg.end = 10;
    release();
    await done;
    expect(writes).toEqual([[0, 32]]);
    expect(seg.written).toBe(10);
  });
});
