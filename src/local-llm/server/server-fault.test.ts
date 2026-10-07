import { describe, expect, it } from "vitest";

import { describeServerFault } from "./server-fault.js";

describe("describeServerFault", () => {
  it("names a GPU out-of-memory and counts it", () => {
    // The shape from the field: the server stayed up and listening
    // while every decode failed, so `health: ok` was true and useless.
    const log = [
      "I srv load_model: initializing, n_slots = 8, n_ctx_slot = 262144",
      "E error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)",
      "E error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)",
      "E llama_decode: failed to decode, ret = -3",
    ].join("\n");
    const fault = describeServerFault(log);
    expect(fault?.occurrences).toBe(2);
    expect(fault?.summary).toContain("GPU ran out of memory 2 times");
    // Past tense: the log is a record. `models status` prints this
    // beside a `daemon: stopped` line, and "the server is up" there was
    // simply false.
    expect(fault?.summary).not.toContain("is up");
    expect(fault?.summary).toContain("localModels.managed.contextSize");
  });

  it("prefers the cause over the symptom it produces", () => {
    // A decode failure is what an OOM looks like from one layer up.
    // Reporting it would send the operator to look at the model.
    const log =
      "E error: kIOGPUCommandBufferCallbackErrorOutOfMemory\nE llama_decode: failed to decode, ret = -3";
    expect(describeServerFault(log)?.summary).toContain(
      "GPU ran out of memory",
    );
  });

  it("names a port collision", () => {
    const log =
      "E srv start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 19091";
    expect(describeServerFault(log)?.summary).toContain(
      "could not take its port",
    );
  });

  it("says nothing about a healthy log", () => {
    const log = [
      "I srv load_model: initializing, n_slots = 1, n_ctx_slot = 16384",
      "I srv llama_server: model loaded",
      "I srv llama_server: listening on http://127.0.0.1:19091",
      "I slot launch_slot_: id 0 | task 0 | processing task",
    ].join("\n");
    expect(describeServerFault(log)).toBeNull();
  });

  it("says nothing about an empty log", () => {
    // A daemon that has not started yet is not a fault.
    expect(describeServerFault("")).toBeNull();
  });
});

describe("only the current daemon's run counts", () => {
  const LAUNCH = "[atomic-agent] launch: model gemma-4-31b (gemma4, 60 layers)";

  it("ignores a fault from an earlier launch", () => {
    // The log is append-only across restarts. Reporting a dead
    // daemon's OOM beside `daemon: running / health: ok` is the same
    // mistake this line exists to prevent, pointed the other way —
    // caught on the feature's first live run.
    const log = [
      LAUNCH,
      "E error: kIOGPUCommandBufferCallbackErrorOutOfMemory",
      "E error: kIOGPUCommandBufferCallbackErrorOutOfMemory",
      LAUNCH,
      "I srv llama_server: model loaded",
      "I srv llama_server: listening on http://127.0.0.1:19091",
    ].join("\n");
    expect(describeServerFault(log)).toBeNull();
  });

  it("still reports a fault in the current run", () => {
    const log = [
      LAUNCH,
      "I srv llama_server: model loaded",
      LAUNCH,
      "E error: kIOGPUCommandBufferCallbackErrorOutOfMemory",
    ].join("\n");
    expect(describeServerFault(log)?.occurrences).toBe(1);
  });

  it("reads a log with no launch marker whole", () => {
    // An external server, or a tail that cut the marker off. Silence
    // on every non-managed setup would be worse than a stale count.
    const log = "E error: kIOGPUCommandBufferCallbackErrorOutOfMemory";
    expect(describeServerFault(log)?.occurrences).toBe(1);
  });
});
