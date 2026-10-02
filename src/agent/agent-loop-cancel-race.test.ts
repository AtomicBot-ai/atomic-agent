import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentLoopEvent } from "./agent-loop.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { TransportError } from "../llm/reliability/llm-failures.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { createEmptySessionState } from "../session/session-state.js";
import type {
  CapabilitiesSummary,
  ToolDescriptor,
} from "../prompt/stable-prefix.js";

/**
 * A stop does not always arrive as an abort. When it lands as a stream
 * ends, the request can come back as whatever the torn-down socket said
 * — `terminated`, `fetch failed` — and the loop read that as a provider
 * outage: it parked the turn on a wait the stop then cut short, closing
 * the turn twice, or (with the wait off) failed the turn with the
 * transport's words. A turn the user stopped is `cancelled`, closed once.
 */

const TOOLS: ToolDescriptor[] = [
  {
    name: "finish",
    summary: "Finish the session with a summary.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

describe("a stop that races the end of a request", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "atomic-agent-cancel-race-"));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function loopWith(
    llmComplete: () => Promise<CompletionResult>,
    events: AgentLoopEvent[],
  ): AgentLoop {
    return new AgentLoop({
      registry: buildDefaultToolRegistry(),
      slotManager: new SlotManager(2),
      grammar: 'root ::= "ok"',
      llmComplete,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
      onEvent: (event) => events.push(event),
    });
  }

  function closes(events: AgentLoopEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === "loop_completed" ? [event.reason] : [],
    );
  }

  it("ends the turn cancelled, not failed, when the stopped request comes back as a transport error", async () => {
    const controller = new AbortController();
    const events: AgentLoopEvent[] = [];
    const loop = loopWith(async () => {
      // The stop lands, and the request it tore down reports the socket.
      controller.abort();
      throw new TransportError("terminated", null, "");
    }, events);
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-race-nowait", workingDir }),
      {
        userMessage: "stop me",
        maxSteps: 5,
        taskMaxSteps: 5,
        providerWaitEnabled: false,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
    expect(result.session.lastError).toBeNull();
    expect(result.session.turnCount).toBe(1);
    expect(closes(events)).toEqual(["cancelled"]);
  });

  it("does not park a stopped turn on a provider wait", async () => {
    const controller = new AbortController();
    const events: AgentLoopEvent[] = [];
    const loop = loopWith(async () => {
      controller.abort();
      throw new TransportError("fetch failed", null, "");
    }, events);
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-race-wait", workingDir }),
      {
        userMessage: "stop me",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
    expect(events.some((event) => event.type === "provider_waiting")).toBe(
      false,
    );
    expect(result.session.turnCount).toBe(1);
    expect(closes(events)).toEqual(["cancelled"]);
  });

  it("closes a turn stopped while parked on an outage exactly once", async () => {
    const controller = new AbortController();
    const events: AgentLoopEvent[] = [];
    const loop = loopWith(async () => {
      // The provider is down; the operator stops the turn while it waits.
      setTimeout(() => controller.abort(), 5);
      throw new TransportError("fetch failed", null, "");
    }, events);
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-park-stop", workingDir }),
      {
        userMessage: "stop me while you wait",
        maxSteps: 5,
        taskMaxSteps: 5,
        signal: controller.signal,
      },
    );
    expect(result.reason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
    expect(events.some((event) => event.type === "provider_waiting")).toBe(
      true,
    );
    // One close, one turn — the wait's exit used to close it a second time.
    expect(closes(events)).toEqual(["cancelled"]);
    expect(
      events.filter((event) => event.type === "turn_finished"),
    ).toHaveLength(1);
    expect(result.session.turnCount).toBe(1);
  });

  it("still fails a request that breaks while nobody has stopped the turn", async () => {
    const events: AgentLoopEvent[] = [];
    const loop = loopWith(async () => {
      throw new TransportError("terminated", null, "");
    }, events);
    const result = await loop.runTurn(
      createEmptySessionState({ id: "s-no-stop", workingDir }),
      {
        userMessage: "work",
        maxSteps: 5,
        taskMaxSteps: 5,
        providerWaitEnabled: false,
        signal: new AbortController().signal,
      },
    );
    expect(result.reason).toBe("failed");
    expect(result.session.status).toBe("failed");
    expect(result.session.lastError).toBe("terminated");
  });
});
