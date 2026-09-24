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
