import { describe, expect, it, vi } from "vitest";

import type { LlmStreamParams } from "../agent/step-executor.js";
import { fakeAnswer } from "../llm/provider/fake-provider.fixture.js";
import { abortableSubcall } from "./abortable-subcall.js";

interface RunnerParams {
  prompt: string;
  grammar: string;
  slotId: number;
  sessionId: string;
  signal: AbortSignal;
}

const shape = (params: RunnerParams) => ({
  prompt: params.prompt,
  grammar: params.grammar,
  slotId: params.slotId,
  sessionId: params.sessionId,
});

function runnerParams(signal: AbortSignal): RunnerParams {
  return {
    prompt: "p",
    grammar: 'root ::= "x"',
    slotId: 3,
    sessionId: "link-gen:s1",
    signal,
  };
}

/** Settles with "hung" when `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "hung" }>((resolve) =>
      setTimeout(() => resolve({ kind: "hung" }), ms),
    ),
  ]);
}

describe("abortableSubcall", () => {
  it("forwards the caller's own signal with the shaped fields untouched", async () => {
    const seen: LlmStreamParams[] = [];
    const complete = vi.fn(async (request: LlmStreamParams) => {
      seen.push(request);
      return fakeAnswer("cloud");
    });
    const controller = new AbortController();
    const params = runnerParams(controller.signal);

    const result = await abortableSubcall(complete, shape)(params);

    expect(result.modelId).toBe("cloud-model");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal).toBe(controller.signal);
    expect(seen[0]).toEqual({ ...shape(params), signal: controller.signal });
  });

  it("forwards the signal even when the shape strips it (reflection spreads the rest)", async () => {
    const seen: LlmStreamParams[] = [];
    const controller = new AbortController();
    const call = abortableSubcall(
      async (request: LlmStreamParams) => {
        seen.push(request);
        return fakeAnswer("cloud");
      },
      ({ signal: _signal, ...rest }: RunnerParams) => rest,
    );
    await call(runnerParams(controller.signal));
    expect(seen[0]!.signal).toBe(controller.signal);
  });

  it("rejects promptly on abort even if the completion never settles, and the inner signal is aborted", async () => {
    let inner: AbortSignal | undefined;
    const call = abortableSubcall((request: LlmStreamParams) => {
      inner = request.signal;
      return new Promise(() => {});
    }, shape);
    const controller = new AbortController();
    const pending = call(runnerParams(controller.signal));
    controller.abort();

    const outcome = await within(pending, 200);
    expect(outcome.kind).toBe("rejected");
    const error = (outcome as { error: unknown }).error;
    expect((error as Error).name).toBe("AbortError");
    expect(inner?.aborted).toBe(true);
  });

  it("never sends a request for a signal that is already aborted", async () => {
    const complete = vi.fn(async () => fakeAnswer("cloud"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortableSubcall(complete, shape)(runnerParams(controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("passes a completion failure through unchanged when nothing aborted", async () => {
    const boom = new Error("provider exploded");
    const call = abortableSubcall(async () => {
      throw boom;
    }, shape);
    await expect(call(runnerParams(new AbortController().signal))).rejects.toBe(
      boom,
    );
  });

  it("detaches its abort listener once the completion settles", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await abortableSubcall(
      async () => fakeAnswer("cloud"),
      shape,
    )(runnerParams(controller.signal));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
