import { describe, expect, it } from "vitest";

import { TurnController } from "../runtime/turn-controller.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * Fusion worker progress over SSE.
 *
 * `fusion.delegate` and the worker runner emit `fusion_worker` through
 * `emitAgentLoopEventFor(parentSessionId, …)`, which hands the event to
 * `TurnController.emit` — the hook registered by the parent's HTTP turn.
 * Before this frame existed the hook dropped the event, so a desktop host
 * saw nothing for the minutes a fan-out held the turn.
 */
describe("fusion_worker over SSE", () => {
  const makeSse = () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    return {
      written,
      writer: {
        closed: false,
        writeEvent(name: string | null, payload: unknown) {
          written.push({ name, payload });
        },
      },
    };
  };
  const env = (extensionsEnabled: boolean) =>
    ({
      completionId: "cmpl-1",
      created: 0,
      session: { id: "parent-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    }) as never;

  it("forwards a worker's tool line as a named extension frame", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({
      type: "fusion_worker",
      taskId: "t1",
      title: "write the parser",
      phase: "tool",
      role: "worker",
      model: "qwen-3.5-4b",
      tool: "os.fs.write",
    });

    expect(sse.written).toEqual([
      {
        name: "fusion_worker",
        payload: {
          object: "atomic.fusion_worker",
          session_id: "parent-1",
          task_id: "t1",
          title: "write the parser",
          phase: "tool",
          role: "worker",
          model: "qwen-3.5-4b",
          tool: "os.fs.write",
        },
      },
    ]);
  });

  it("carries the finish figures, and reads an absent role as a worker", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({
      type: "fusion_worker",
      taskId: "t2",
      title: "tests",
      phase: "finished",
      stepCount: 7,
      durationMs: 41_200,
      summary: "wrote 3 files",
    });

    expect(sse.written).toHaveLength(1);
    expect(sse.written[0]!.payload).toEqual({
      object: "atomic.fusion_worker",
      session_id: "parent-1",
      task_id: "t2",
      title: "tests",
      phase: "finished",
      role: "worker",
      step_count: 7,
      duration_ms: 41_200,
      summary: "wrote 3 files",
    });
  });

  it("keeps the orchestrator's own bracket line distinguishable", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));

    hook({
      type: "fusion_worker",
      taskId: "fusion.delegate",
      title: "3 tasks",
      phase: "tool",
      role: "orchestrator",
      model: "x-ai/grok-4-6",
      tool: "fusion.delegate",
    });

    const payload = sse.written[0]!.payload as { role: string; task_id: string };
    expect(payload.role).toBe("orchestrator");
    expect(payload.task_id).toBe("fusion.delegate");
  });

  it("sends nothing to an OpenAI-compatible client", () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(false));

    hook({
      type: "fusion_worker",
      taskId: "t1",
      title: "x",
      phase: "started",
    });

    expect(sse.written).toEqual([]);
  });

  it("reaches the parent turn's hook through TurnController.emit while the turn runs", async () => {
    const sse = makeSse();
    const hook = buildStreamEventHook(sse.writer as never, env(true));
    const controller = new TurnController();

    await controller.enqueue({
      sessionId: "parent-1",
      origin: "http",
      eventHook: hook,
      run: async () => {
        // What emitAgentLoopEventFor does for a worker's progress line:
        // the PARENT's id, explicitly, from inside the worker's own frame.
        controller.emit("parent-1", {
          type: "fusion_worker",
          taskId: "t1",
          title: "write the parser",
          phase: "started",
          role: "worker",
          model: "qwen-3.5-4b",
        });
        // A worker session's id reaches nobody — no hook is registered for it.
        controller.emit("worker-ephemeral", {
          type: "fusion_worker",
          taskId: "t1",
          title: "write the parser",
          phase: "tool",
          tool: "os.fs.read",
        });
      },
    });

    expect(sse.written.map((w) => w.name)).toEqual(["fusion_worker"]);
    expect((sse.written[0]!.payload as { phase: string }).phase).toBe("started");
  });
});
