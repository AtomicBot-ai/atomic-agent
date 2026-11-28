import { describe, expect, it } from "vitest";

import { DEFAULT_FUSION_CLOUD_WORKERS } from "../../config/llm-run-mode-config.js";
import type { DelegateTask } from "./delegate-args.js";
import { coreWorkerOptions, legWorkerWidth } from "./worker-leg-options.js";

/**
 * The options every leg of a fan-out gets (ATO-2446), shared by
 * `fusion.delegate`'s worker and role legs and by `subagent.run`.
 */

const tasks: DelegateTask[] = [
  { id: "a", title: "A", instructions: "Do A." },
  { id: "b", title: "B", instructions: "Do B." },
];
const signal = new AbortController().signal;
const mode = { workerMaxSteps: 12, workerTimeoutMs: 60_000 };

describe("legWorkerWidth", () => {
  it("runs one at a time on a local leg", () => {
    expect(legWorkerWidth(true, 5, 8)).toBe(1);
  });

  it("takes the task count up to the cloud cap on a cloud leg", () => {
    expect(legWorkerWidth(false, 3, 8)).toBe(3);
    expect(legWorkerWidth(false, 10, 4)).toBe(4);
    expect(legWorkerWidth(false, 0, 4)).toBe(1);
  });

  it("falls back to the default cloud cap", () => {
    expect(legWorkerWidth(false, 100, undefined)).toBe(DEFAULT_FUSION_CLOUD_WORKERS);
  });
});

describe("coreWorkerOptions", () => {
  it("carries the leg, the limits and the signal, and nothing unset", () => {
    const options = coreWorkerOptions({
      parentSessionId: "s-parent",
      tasks,
      leg: { providerId: "local", workerModel: "qwen" },
      maxWorkers: 2,
      localLeg: true,
      mode,
      workerMaxOutputTokens: undefined,
      signal,
    });
    expect(options).toStrictEqual({
      parentSessionId: "s-parent",
      tasks,
      maxWorkers: 2,
      providerId: "local",
      workerModel: "qwen",
      workerMaxSteps: 12,
      workerTimeoutMs: 60_000,
      localLeg: true,
      signal,
    });
    for (const key of [
      "turnModel",
      "workerReasoning",
      "workerMaxOutputTokens",
      "originalRequest",
      "writeScope",
    ]) {
      expect(key in options).toBe(false);
    }
  });

  it("passes every optional field that is set", () => {
    const options = coreWorkerOptions({
      parentSessionId: "s-parent",
      tasks,
      leg: { providerId: "cloud", workerModel: "gpt (coder)", turnModel: "gpt" },
      maxWorkers: 4,
      localLeg: false,
      mode: { ...mode, workerReasoning: "low" },
      workerMaxOutputTokens: 2048,
      originalRequest: "build it",
      writeScope: ["/repo"],
      signal,
    });
    expect(options).toMatchObject({
      providerId: "cloud",
      workerModel: "gpt (coder)",
      turnModel: "gpt",
      localLeg: false,
      workerReasoning: "low",
      workerMaxOutputTokens: 2048,
      originalRequest: "build it",
      writeScope: ["/repo"],
    });
  });

  it("keeps an empty write scope when one is given", () => {
    const options = coreWorkerOptions({
      parentSessionId: "s",
      tasks,
      leg: { providerId: "p", workerModel: "m" },
      maxWorkers: 1,
      localLeg: false,
      mode,
      workerMaxOutputTokens: undefined,
      writeScope: [],
      signal,
    });
    expect(options.writeScope).toEqual([]);
  });
});
