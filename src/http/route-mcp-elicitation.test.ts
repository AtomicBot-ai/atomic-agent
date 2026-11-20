import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpElicitationBroker } from "../mcp/mcp-elicitation-broker.js";
import type { McpElicitationQuestion } from "../mcp/mcp-elicitation-handler.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const CONFIRM: McpElicitationQuestion = { server: "demo", message: "Send it?", fields: [] };
const PIN: McpElicitationQuestion = {
  server: "demo",
  message: "Enter the code",
  fields: [{ name: "pin", kind: "string", required: true, sensitive: true }],
};

/** Read an SSE stream until `until` shows up in it. */
async function readEvents(
  baseUrl: string,
  query: string,
  until: string,
): Promise<{ text: string; stop: () => Promise<void> }> {
  const stream = new AbortController();
  const res = await fetch(`${baseUrl}/api/events${query}`, { signal: stream.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(until)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return {
    text,
    stop: async () => {
      stream.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function answer(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/mcp/elicitation/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("MCP elicitation over HTTP (ATO-1492)", () => {
  let harness: Harness;
  let broker: McpElicitationBroker;

  beforeEach(async () => {
    let n = 0;
    broker = new McpElicitationBroker({ newId: () => `e${++n}` });
    // Level 5 approves every action by itself: a server's question must
    // still wait for a person.
    harness = await startTestHarness({ approvalLevel: 5, elicitations: broker });
  });

  afterEach(async () => {
    broker.closeAll();
    await harness.cleanup();
  });

  it("an older window (no opt-in) is not a presenter, so nobody is there", async () => {
    const res = await fetch(`${harness.baseUrl}/api/events`);
    expect(broker.surface()).toBe("none");
    await res.body?.cancel();
  });

  it("shows a plain confirm question to an opted-in window, even at approval level 5", async () => {
    const reply = (async () => {
      // Wait for the window to attach before the server asks.
      while (broker.surface() === "none") await new Promise((r) => setTimeout(r, 5));
      return broker.ask(CONFIRM, new AbortController().signal);
    })();
    const events = await readEvents(harness.baseUrl, "?elicitation=1", "mcp_elicitation");
    expect(events.text).toContain("event: mcp_elicitation");
    expect(events.text).toContain("Send it?");
    expect(broker.pending()).toHaveLength(1);

    const res = await answer(harness.baseUrl, { id: "e1", action: "accept" });
    expect(res.status).toBe(200);
    await expect(reply).resolves.toEqual({ action: "accept", content: {} });
    await events.stop();
  });

  it("keeps the question open on an answer that does not fit, and never echoes the value", async () => {
    const window = broker.attach({ surface: "interactive", onEvent: () => {} });
    const reply = broker.ask(PIN, new AbortController().signal);
    const bad = await answer(harness.baseUrl, { id: "e1", action: "accept", content: { pin: 1234 } });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).toContain("pin");
    expect(text).not.toContain("1234");
    expect(broker.pending()).toHaveLength(1);

    const ok = await answer(harness.baseUrl, { id: "e1", action: "decline" });
    expect(ok.status).toBe(200);
    await expect(reply).resolves.toEqual({ action: "decline" });
    window();
  });

  it("404 for a question that is no longer open, 400 for an unknown action", async () => {
    expect((await answer(harness.baseUrl, { id: "ghost", action: "decline" })).status).toBe(404);
    const window = broker.attach({ surface: "interactive", onEvent: () => {} });
    void broker.ask(CONFIRM, new AbortController().signal);
    expect((await answer(harness.baseUrl, { id: "e1", action: "allow-once" })).status).toBe(400);
    window();
  });

  it("the approval route cannot answer it", async () => {
    const window = broker.attach({ surface: "interactive", onEvent: () => {} });
    void broker.ask(CONFIRM, new AbortController().signal);
    const res = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "e1", decision: "allow-once" }),
    });
    expect(res.status).toBe(404);
    expect(broker.pending()).toHaveLength(1);
    window();
  });

  it("lists open questions and says so on /api/capabilities", async () => {
    const window = broker.attach({ surface: "interactive", onEvent: () => {} });
    void broker.ask(CONFIRM, new AbortController().signal);
    const list = (await (await fetch(`${harness.baseUrl}/api/mcp/elicitation`)).json()) as {
      elicitations: { id: string }[];
    };
    expect(list.elicitations.map((e) => e.id)).toEqual(["e1"]);
    const caps = (await (await fetch(`${harness.baseUrl}/api/capabilities`)).json()) as {
      agent: { mcpElicitation: boolean };
    };
    expect(caps.agent.mcpElicitation).toBe(true);
    window();
  });
});
