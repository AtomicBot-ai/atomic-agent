import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { AtomicAgent, AtomicAgentError, SidecarExitedError } from "./index.js";
import type { AgentEvent, ApprovalRequestPayload } from "./index.js";

const FAKE_SIDECAR = fileURLToPath(
  new URL("../test/fake-sidecar.mjs", import.meta.url),
);

const agents: AtomicAgent[] = [];
function makeAgent(
  options: ConstructorParameters<typeof AtomicAgent>[0] = {},
): AtomicAgent {
  const agent = new AtomicAgent({ binary: FAKE_SIDECAR, ...options });
  agents.push(agent);
  return agent;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close(2000)));
});

describe("AtomicAgent over the NDJSON sidecar", () => {
  it("pings the sidecar and passes env through", async () => {
    const agent = makeAgent({ env: { FAKE_STATE_DIR: "/tmp/sdk-state" } });
    const pong = await agent.ping();
    expect(pong.version).toBe("0.0.0-fake");
    expect(pong.stateDir).toBe("/tmp/sdk-state");
  });

  it("run() resolves with the final reply, not the progress note", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread({ workingDir: "/tmp/work" });
    expect(thread.id).toBe("s-1");
    expect(thread.workingDir).toBe("/tmp/work");

    const result = await thread.run("hello", { maxSteps: 7 });
    expect(result.finalResponse).toBe("Hello from 7 steps");
    expect(result.reason).toBe("reply");
    expect(result.turnCount).toBe(1);
    const types = result.events.map((e) => e.type);
    expect(types[0]).toBe("turn_started");
    expect(types.at(-1)).toBe("turn_finished");
  });

  it("runStreamed() yields this session's events in order and ends", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread();
    const { events, result } = thread.runStreamed("hello");

    const deltas: string[] = [];
    const seen: AgentEvent[] = [];
    for await (const event of events) {
      seen.push(event);
      if (event.type === "assistant_delta") deltas.push(event.payload.text);
    }
    // The delta for "someone-else" is filtered out.
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(seen.some((e) => e.type === "log")).toBe(true);
    expect((await result).events).toEqual(seen);
  });

  it("answers approval requests through onApprovalRequest", async () => {
    const asked: ApprovalRequestPayload[] = [];
    const agent = makeAgent({
      onApprovalRequest: (request) => {
        asked.push(request);
        return { approved: true, grant: "session" };
      },
    });
    const thread = await agent.startThread();
    const result = await thread.run("needs approval");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.tool).toBe("os.shell");
    expect(result.finalResponse).toBe("ran it");
    const tool = result.events.find((e) => e.type === "tool_call_result");
    expect(tool?.type === "tool_call_result" && JSON.parse(tool.payload.summary)).toMatchObject({
      approved: true,
      grant: "session",
      approvalId: asked[0]?.approvalId,
    });
  });

  it("denies approval requests when no handler is set", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread();
    const result = await thread.run("needs approval");
    expect(result.finalResponse).toBe("denied");
  });

  it("an AbortSignal cancels the running turn", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread();
    const controller = new AbortController();
    const running = thread.run("slow", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await running;
    expect(result.reason).toBe("cancelled");
  });

  it("a failed request rejects with AtomicAgentError", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread();
    const error = await thread.run("fail").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtomicAgentError);
    expect((error as AtomicAgentError).code).toBe("handler_failed");
    expect((error as AtomicAgentError).message).toBe("model exploded");
  });

  it("a crashed sidecar rejects the stream with its stderr", async () => {
    const agent = makeAgent();
    const thread = await agent.startThread();
    const { events, result } = thread.runStreamed("crash");
    const consume = (async () => {
      for await (const _ of events) void _;
    })();
    await expect(consume).rejects.toBeInstanceOf(SidecarExitedError);
    const error = (await result.catch((e: unknown) => e)) as SidecarExitedError;
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toContain("crashed on purpose");
  });

  it("a missing binary fails with a hint", async () => {
    const agent = makeAgent({ binary: "atomic-agent-sidecar-does-not-exist" });
    const error = await agent.ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SidecarExitedError);
    expect((error as Error).message).toContain("on PATH");
  });

  it("startThread() replaces the previous thread", async () => {
    const agent = makeAgent();
    const first = await agent.startThread();
    const second = await agent.startThread();
    expect(second.id).not.toBe(first.id);
    await expect(first.run("hello")).rejects.toThrow(/replaced/);
    expect((await second.run("hello")).finalResponse).toContain("Hello");
  });

  it("close() stops the process and the agent", async () => {
    const agent = makeAgent();
    await agent.ping();
    await agent.close();
    await agent.close();
    await expect(agent.ping()).rejects.toThrow(/closed/);
  });
});
